"""Website-only adaptive provider pool primitives.

The pool is deliberately small and provider-neutral.  It produces the same
``AIRoute`` consumed by the existing providers, so billing, SSE, cancellation,
and Free's local route remain owned by their existing code paths.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import os
import re
from typing import Any

from .intent import classify_intent_with_metadata
from .language import detect_language
from .providers.sarvam_provider import sarvam_chat_max_tokens
from .types import AIRequest, AIRoute


MULTI_PROVIDER_ROUTING_ENV = "WEB_MULTI_PROVIDER_ROUTING_ENABLED"
_ALIAS_RE = re.compile(r"^(openai|sarvam):([A-Za-z0-9._:-]{1,128})$")

ALIAS_DEFAULTS: dict[str, str] = {
    "lite_fast": "openai:gpt-5.4-nano",
    "lite_multilingual": "sarvam:sarvam-105b",
    "standard_balanced": "openai:gpt-5.6-terra",
    "standard_multilingual": "sarvam:sarvam-105b",
    "pro_reasoning": "openai:gpt-5.6-sol",
    "pro_multilingual": "sarvam:sarvam-105b",
    "vision_primary": "openai:gpt-5.5",
    "embedding_primary": "openai:text-embedding-3-small",
}

_ALIASES = tuple(ALIAS_DEFAULTS)
_INDIC_INTENTS = frozenset({
    "translation", "contextual_translate", "contextual_explain",
})
_COMPLEX_INTENTS = frozenset({"coding", "complex_reasoning"})
_TERMINAL_PROVIDERS = frozenset({"openai", "sarvam"})


def multi_provider_routing_enabled(environ: dict[str, str] | None = None) -> bool:
    env = os.environ if environ is None else environ
    return str(env.get(MULTI_PROVIDER_ROUTING_ENV, "false") or "").strip().lower() in {
        "1", "true", "yes", "on",
    }


@dataclass(frozen=True)
class ProviderAlias:
    name: str
    provider: str
    model: str


def parse_provider_alias(name: str, value: str) -> ProviderAlias:
    match = _ALIAS_RE.fullmatch(str(value or "").strip())
    if not match:
        raise ValueError(f"{name} must use provider:model syntax")
    return ProviderAlias(name, match.group(1), match.group(2))


def configured_provider_aliases(
    environ: dict[str, str] | None = None,
    *,
    require_all: bool = True,
) -> dict[str, ProviderAlias]:
    env = os.environ if environ is None else environ
    aliases: dict[str, ProviderAlias] = {}
    errors: list[str] = []
    for name, default in ALIAS_DEFAULTS.items():
        value = str(env.get(f"SWICO_MODEL_ALIAS_{name.upper()}", default) or "").strip()
        if not value and not require_all:
            continue
        try:
            aliases[name] = parse_provider_alias(name, value)
        except ValueError:
            errors.append(f"SWICO_MODEL_ALIAS_{name.upper()}")
    if errors:
        raise ValueError("invalid provider alias configuration: " + ", ".join(errors))
    return aliases


class ProviderCapabilityRegistry:
    """Bounded capability facts; no provider call is made here."""

    def supports(self, provider: str, capability: str) -> bool:
        if provider not in _TERMINAL_PROVIDERS:
            return False
        if capability == "vision":
            return provider == "openai"
        if capability == "embedding":
            return provider == "openai"
        return True


class ProviderHealthRegistry:
    """Small request-local health view, extensible from existing health data."""

    def __init__(self, unhealthy: set[str] | None = None) -> None:
        self._unhealthy = set(unhealthy or ())

    def is_healthy(self, provider: str, model: str = "") -> bool:
        if provider in self._unhealthy:
            return False
        if model:
            try:
                from .model_health import model_health_snapshot

                if any(
                    row.get("provider") == provider
                    and row.get("model") == model
                    for row in model_health_snapshot()
                ):
                    return False
            except Exception:
                # A health-cache failure must not turn routing into a crash.
                pass
        return True


class ProviderCostEstimator:
    """Stable relative scores used only to break suitable-provider ties."""

    def score(self, provider: str, *, task: str, language: str) -> float:
        if language != "en" and provider == "sarvam":
            return 0.9
        if task == "simple" and provider == "openai":
            return 0.9
        return 0.7


@dataclass(frozen=True)
class ProviderExecutionPlan:
    primary: ProviderAlias
    alternate: ProviderAlias | None
    capability: str = "text"
    max_provider_calls: int = 1


class ProviderTriagPlanner:
    """Select aliases for a paid website request without generating twice."""

    def __init__(
        self,
        *,
        aliases: dict[str, ProviderAlias] | None = None,
        health: ProviderHealthRegistry | None = None,
    ) -> None:
        self.aliases = aliases or configured_provider_aliases()
        self.health = health or ProviderHealthRegistry()
        self.capabilities = ProviderCapabilityRegistry()
        self.cost = ProviderCostEstimator()

    def plan(self, request: AIRequest, tier: str) -> ProviderExecutionPlan:
        normalized_tier = str(tier or "lite").strip().lower()
        if normalized_tier == "free":
            raise ValueError("Swico Free cannot use the paid provider pool")
        language = detect_language(request.message, request.reply_language)
        decision = classify_intent_with_metadata(request.message)
        intent = decision.intent
        task = "complex" if intent in _COMPLEX_INTENTS else (
            "simple" if intent in {"general", "greeting", "thanks"} else "normal"
        )
        has_vision = bool(
            request.metadata.get("vision_inputs")
            or request.metadata.get("image_uploads")
        )
        capability = "vision" if has_vision else "text"
        if has_vision:
            primary_name = "vision_primary"
        elif normalized_tier == "lite":
            primary_name = "lite_multilingual" if (
                language.reply_language != "en"
                or language.input_language != "en"
                or language.code_mixed
                or intent in _INDIC_INTENTS
            ) else "lite_fast"
        elif normalized_tier == "standard":
            if language.reply_language != "en" or language.input_language != "en":
                primary_name = "standard_multilingual"
            elif task == "simple":
                primary_name = "lite_fast"
            else:
                primary_name = "standard_balanced"
        else:  # pro
            primary_name = (
                "pro_multilingual"
                if language.reply_language != "en" or language.input_language != "en"
                else "pro_reasoning"
            )
        primary = self.aliases[primary_name]
        alternate_name = self._alternate_name(primary_name, normalized_tier)
        alternate = self.aliases.get(alternate_name) if alternate_name else None
        if alternate and alternate.provider == primary.provider:
            alternate = None
        if (
            not self.capabilities.supports(primary.provider, capability)
            and alternate
            and self.capabilities.supports(alternate.provider, capability)
        ):
            primary, alternate = alternate, primary
        if not self.health.is_healthy(primary.provider, primary.model) and alternate:
            primary, alternate = alternate, primary
        calls = {"lite": 2, "standard": 3, "pro": 3}.get(normalized_tier, 1)
        return ProviderExecutionPlan(primary, alternate, capability, calls)

    @staticmethod
    def _alternate_name(primary_name: str, tier: str) -> str | None:
        if primary_name in {"lite_fast", "standard_balanced", "pro_reasoning"}:
            return {
                "lite_fast": "lite_multilingual",
                "standard_balanced": "standard_multilingual",
                "pro_reasoning": "pro_multilingual",
            }[primary_name]
        if primary_name in {"lite_multilingual", "standard_multilingual", "pro_multilingual"}:
            return {
                "lite_multilingual": "lite_fast",
                "standard_multilingual": "standard_balanced",
                "pro_multilingual": "pro_reasoning",
            }[primary_name]
        return "standard_balanced" if tier == "standard" else "pro_reasoning"

    def route(self, request: AIRequest, tier: str, *, max_output_tokens: int) -> AIRoute:
        plan = self.plan(request, tier)
        language = detect_language(request.message, request.reply_language)
        decision = classify_intent_with_metadata(request.message)
        visible_budget = max(1, int(max_output_tokens or 1))
        if plan.primary.provider == "sarvam":
            visible_budget = min(visible_budget, sarvam_chat_max_tokens())
        metadata = {
            **dict(request.metadata or {}),
            "provider_pool_enabled": True,
            "provider_pool_alias": plan.primary.name,
            "provider_pool_alternate_alias": plan.alternate.name if plan.alternate else "",
            "provider_pool_alternate_provider": plan.alternate.provider if plan.alternate else "",
            "provider_pool_alternate_model": plan.alternate.model if plan.alternate else "",
            "provider_pool_capability": plan.capability,
            "provider_call_ceiling": plan.max_provider_calls,
        }
        return AIRoute(
            provider=plan.primary.provider, model=plan.primary.model,
            route=f"{plan.primary.provider}_pool_{decision.intent}",
            reason=f"{decision.reason}:provider_pool_{plan.primary.name}",
            language=language.language, intent=decision.intent,
            max_output_tokens=visible_budget,
            needs_voice_output=request.channel in {"voice", "handsfree"},
            model_candidates=[plan.primary.model],
            metadata=metadata,
        )

    def alternate_route(self, route: AIRoute, *, max_output_tokens: int | None = None) -> AIRoute | None:
        provider = str(route.metadata.get("provider_pool_alternate_provider") or "")
        model = str(route.metadata.get("provider_pool_alternate_model") or "")
        if provider not in _TERMINAL_PROVIDERS or not model:
            return None
        original_provider = route.provider
        original_model = route.model or ""
        return replace(
            route,
            provider=provider, model=model,
            route=f"{provider}_pool_alternate_for_{route.intent}",
            reason=f"{route.reason}:alternate_provider",
            max_output_tokens=max_output_tokens or route.max_output_tokens,
            model_candidates=[model], provider_endpoint_candidates=[],
            metadata={
                **route.metadata,
                "provider_pool_alternate_selected": True,
                "provider_pool_alternate_provider": original_provider,
                "provider_pool_alternate_model": original_model,
            },
        )

    def verifier_route(self, route: AIRoute, *, max_output_tokens: int = 96) -> AIRoute | None:
        return self.alternate_route(route, max_output_tokens=max_output_tokens)

    def repair_route(self, route: AIRoute, *, max_output_tokens: int) -> AIRoute | None:
        return self.alternate_route(route, max_output_tokens=max_output_tokens)


class MultiProviderBroker:
    """Facade used by callers that need selection plus bounded fallback."""

    def __init__(self, planner: ProviderTriagPlanner | None = None) -> None:
        self.planner = planner or ProviderTriagPlanner()

    def plan(self, request: AIRequest, tier: str, *, max_output_tokens: int) -> AIRoute:
        return self.planner.route(request, tier, max_output_tokens=max_output_tokens)

    def alternate(self, route: AIRoute, *, max_output_tokens: int | None = None) -> AIRoute | None:
        return self.planner.alternate_route(route, max_output_tokens=max_output_tokens)


class EmbeddingProviderRouter:
    def __init__(self, aliases: dict[str, ProviderAlias] | None = None) -> None:
        self.aliases = aliases or configured_provider_aliases()

    def route(self, tier: str, *, fallback_model: str = "text-embedding-3-small") -> ProviderAlias:
        if str(tier or "").lower() == "free":
            return ProviderAlias("local_free", "swico_free", "e5")
        if not multi_provider_routing_enabled():
            # The rollout flag preserves the existing OpenAI embedding path,
            # including custom WEB_RAG_EMBEDDING_MODEL values.
            return ProviderAlias("embedding_primary", "openai", fallback_model)
        return self.aliases.get(
            "embedding_primary",
            ProviderAlias("embedding_primary", "openai", fallback_model),
        )


class ContextBudgetManager:
    def allocate(self, requested: int, *, cap: int) -> int:
        return min(max(0, int(requested)), max(0, int(cap)))


class CrossProviderVerifier:
    def __init__(self, planner: ProviderTriagPlanner | None = None) -> None:
        self.planner = planner or ProviderTriagPlanner()

    def route_for(self, generation_route: AIRoute, *, max_output_tokens: int = 96) -> AIRoute | None:
        return self.planner.verifier_route(generation_route, max_output_tokens=max_output_tokens)


class TargetedAnswerRepair:
    def __init__(self, planner: ProviderTriagPlanner | None = None) -> None:
        self.planner = planner or ProviderTriagPlanner()

    def route_for(self, generation_route: AIRoute, *, max_output_tokens: int) -> AIRoute | None:
        return self.planner.repair_route(generation_route, max_output_tokens=max_output_tokens)


class ProviderUsageSettlement:
    """Provider-neutral stage labels for existing usage-stage settlement."""

    STAGES = ("routing", "embedding", "generation", "verification", "repair")

    @classmethod
    def stage_metadata(cls, stage: str) -> dict[str, Any]:
        return {"usage_stage": stage if stage in cls.STAGES else "generation"}
