from __future__ import annotations

import os
import re
from datetime import datetime
from dataclasses import replace

from ..openai_model_router import OpenAIModelRouter
from .provider_pool import MultiProviderBroker, multi_provider_routing_enabled
from .swico_tiers import SwicoTierUnavailableError, free_enabled, free_output_token_ceiling
from .intent import IntentDecision, classify_intent_with_metadata, normalize_voice_query_for_intent
from .freshness import resolve_freshness
from .language import detect_language
from .prompts import concise_max_output_tokens
from .providers.sarvam_provider import chat_model_for_intent
from .types import AIRequest, AIRoute


class AIProviderRouter:
    def select_route(
        self, request: AIRequest, *, now: datetime | None = None,
    ) -> AIRoute:
        language = detect_language(request.message, request.reply_language)
        language_metadata = {
            "input_language": language.input_language,
            "reply_language": language.reply_language or request.reply_language or language.language,
            "provider_preference": language.provider_preference or language.prefer_provider,
        }
        intent_normalization = normalize_voice_query_for_intent(request.message)
        forced_contextual = str(request.metadata.get("contextual_intent") or "").strip()
        intent = (
            IntentDecision(
                intent=forced_contextual,
                route=forced_contextual,
                reason=f"{forced_contextual}_uses_recent_context",
                metadata={
                    **intent_normalization,
                    "intent_before_cleanup": forced_contextual,
                    "intent_after_cleanup": forced_contextual,
                },
            )
            if forced_contextual.startswith("contextual_")
            else classify_intent_with_metadata(request.message)
        )
        intent_metadata = {
            **language_metadata,
            "original_message": intent.metadata.get("original") or request.message,
            "normalized_message": intent.metadata.get("normalized") or request.message,
            "stripped_wake_word": bool(intent.metadata.get("stripped_wake_word")),
            "stripped_prefix": intent.metadata.get("stripped_prefix") or "",
            "intent_before_cleanup": intent.metadata.get("intent_before_cleanup") or intent.intent,
            "intent_after_cleanup": intent.intent,
        }
        freshness_context = "\n".join(
            value
            for turn in request.context_turns[-4:]
            for value in (str(turn.get("user") or ""), str(turn.get("assistant") or ""))
            if value
        )
        freshness = resolve_freshness(
            request.message, context=freshness_context, now=now,
        )
        intent_metadata.update({
            "freshness_scope": freshness.scope,
            "freshness_required": freshness.requires_fresh_evidence,
            "freshness_reason": freshness.reason,
            "freshness_as_of": freshness.as_of,
            "freshness_historical_as_of": freshness.historical_as_of,
        })
        if intent.metadata.get("tool_intent_candidate"):
            intent_metadata["tool_intent_candidate"] = intent.metadata[
                "tool_intent_candidate"
            ]
        max_output_tokens = _max_output_tokens(request.message)

        if intent.intent in {
            "unsafe_or_sensitive", "urgent_medical_emergency",
            "harmful_credential_abuse",
        }:
            return AIRoute(
                provider="blocked",
                model=None,
                route=(
                    "medical_emergency_guidance"
                    if intent.intent == "urgent_medical_emergency"
                    else "credential_abuse_safety_block"
                    if intent.intent == "harmful_credential_abuse"
                    else "safety_block"
                ),
                reason=intent.reason,
                language=language.language,
                intent=intent.intent,
                max_output_tokens=0,
                metadata=intent_metadata,
            )

        if freshness.requires_fresh_evidence and intent.intent == "general":
            intent = IntentDecision(
                intent="live_data", route="blocked_live_data",
                reason=freshness.reason, metadata=intent.metadata,
            )
        if intent.intent in {"weather", "live_data"}:
            paid_web_tier = str(request.metadata.get("swico_tier") or "").strip().lower() in {
                "lite", "standard", "pro",
            }
            # Paid web search has an independent capability policy. The
            # legacy flag remains a Free-only switch and must not gate paid
            # tier routing.
            if not paid_web_tier and not _env_bool("ENABLE_WEB_SEARCH_FOR_FREE", False):
                return AIRoute(
                    provider="blocked",
                    model=None,
                    route="live_data_disabled",
                    reason="web_search_disabled_for_free_users",
                    language=language.language,
                    intent=intent.intent,
                    max_output_tokens=0,
                    metadata=intent_metadata,
                )

        web_attachment_qa = bool(
            request.metadata.get("client_surface") == "web"
            and (
                intent.intent in {"document", "file_retrieval"}
                or (
                    intent.intent == "general"
                    and re.search(
                        r"\b(?:attached|uploaded)\s+\b(?:pdf|document|file|spreadsheet|"
                        r"presentation|word document)\b",
                        request.message,
                        re.IGNORECASE,
                    )
                )
            )
            and int(request.metadata.get("validated_attachment_count") or 0) > 0
            and bool(request.metadata.get("validated_attachment_chunks_present"))
        )
        if web_attachment_qa and intent.intent == "general":
            intent = IntentDecision(
                intent="document",
                route="general",
                reason="validated_attachment_question",
                metadata=intent.metadata,
            )
            intent_metadata["intent_after_cleanup"] = "live_data"
        if intent.route == "backend_tool" and not web_attachment_qa:
            return AIRoute(
                provider="backend_tool",
                model=None,
                route=f"backend_tool_{intent.intent}",
                reason=intent.reason,
                language=language.language,
                intent=intent.intent,
                max_output_tokens=0,
                metadata=intent_metadata,
            )

        if web_attachment_qa:
            intent_metadata["web_attachment_qa"] = True

        swico_tier = str(request.metadata.get("swico_tier") or "").strip().lower()
        if request.metadata.get("client_surface") == "web" and swico_tier:
            if swico_tier == "free":
                if not free_enabled():
                    raise SwicoTierUnavailableError("Swico Free is not enabled")
                return AIRoute(
                    provider="swico_free",
                    model=None,
                    route=f"swico_free_{intent.intent}",
                    reason=f"{intent.reason}:configured_swico_free",
                    language=language.language,
                    intent=intent.intent,
                    max_output_tokens=min(
                        max_output_tokens,
                        free_output_token_ceiling(),
                    ),
                    metadata={**intent_metadata, "swico_tier": "free"},
                )
            if multi_provider_routing_enabled() and swico_tier in {
                "lite", "standard", "pro",
            }:
                route = MultiProviderBroker().plan(
                    replace(request, metadata={**request.metadata, **intent_metadata}),
                    swico_tier,
                    max_output_tokens=max_output_tokens,
                )
                return replace(
                    route,
                    metadata={
                        **route.metadata,
                        "swico_tier": swico_tier,
                        "intent_before_cleanup": intent_metadata.get("intent_before_cleanup"),
                        "intent_after_cleanup": intent_metadata.get("intent_after_cleanup"),
                    },
                )
            permission_tier = str(request.metadata.get("user_tier") or "paid")
            model_router = OpenAIModelRouter()
            selections = model_router.select_swico_candidates(
                swico_tier, request.message, user_tier=permission_tier
            )
            selection = selections[0]
            selection_meta = model_router.last_selection_metadata
            return AIRoute(
                provider="openai",
                model=selection.model,
                route=f"openai_{intent.intent}",
                reason=f"{intent.reason}:{selection.reason}",
                language=language.language,
                intent=intent.intent,
                max_output_tokens=max_output_tokens,
                model_candidates=[candidate.model for candidate in selections],
                provider_endpoint_candidates=[candidate.endpoint for candidate in selections],
                metadata={
                    **intent_metadata,
                    "swico_tier": swico_tier,
                    "model_tier": selection.tier,
                    "primary_model_candidate": selection_meta.get("primary_model_candidate") or selection.model,
                    "selected_model_reason": selection_meta.get("selected_model_reason") or "configured_swico_tier",
                    "skipped_models": selection_meta.get("skipped_models") or [],
                    "model_health_skip_reason": selection_meta.get("model_health_skip_reason") or "",
                },
            )

        web_routing_mode = (
            str(os.getenv("AI_PROVIDER_ROUTING_MODE", "cost_optimized")).strip().lower()
            if request.metadata.get("client_surface") == "web"
            else ""
        )
        prefer_sarvam = language.prefer_provider == "sarvam" or intent.intent in {
            "translation", "tts", "stt", "contextual_translate", "contextual_explain",
        }
        if web_routing_mode == "openai_only":
            prefer_sarvam = False
        elif web_routing_mode == "sarvam_only":
            prefer_sarvam = True

        if prefer_sarvam:
            model = chat_model_for_intent(intent.intent)
            return AIRoute(
                provider="sarvam",
                model=model,
                route=f"sarvam_{intent.intent}",
                reason=f"{language.reason}:{intent.reason}",
                language=language.language,
                intent=intent.intent,
                max_output_tokens=max_output_tokens,
                needs_voice_output=request.channel in {"voice", "handsfree"},
                metadata=intent_metadata,
            )

        openai_task = "coding" if intent.intent in {"coding", "complex_reasoning"} else "normal_qa"
        user_tier = str(request.metadata.get("user_tier") or request.metadata.get("tier") or "free")
        model_router = OpenAIModelRouter()
        selections = model_router.select_candidates(
            openai_task,
            request.message,
            route=intent.route,
            user_tier=user_tier,
        )
        selection = selections[0] if selections else model_router.select_model(openai_task, request.message, route=intent.route)
        selection_meta = getattr(model_router, "last_selection_metadata", {}) or {}
        return AIRoute(
            provider="openai",
            model=selection.model,
            route=f"openai_{intent.intent}",
            reason=f"{intent.reason}:{selection.reason}",
            language=language.language,
            intent=intent.intent,
            max_output_tokens=max_output_tokens,
            needs_voice_output=request.channel in {"voice", "handsfree"},
            model_candidates=[candidate.model for candidate in selections] or [selection.model],
            provider_endpoint_candidates=[candidate.endpoint for candidate in selections] or [selection.endpoint],
            metadata={
                **intent_metadata,
                "model_tier": selection.tier,
                "primary_model_candidate": selection_meta.get("primary_model_candidate") or selection.model,
                "selected_model_reason": selection_meta.get("selected_model_reason") or "cost_optimizer_choice",
                "skipped_models": selection_meta.get("skipped_models") or [],
                "model_health_skip_reason": selection_meta.get("model_health_skip_reason") or "",
            },
        )


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _max_output_tokens(message: str = "") -> int:
    try:
        default = int(str(os.getenv("OPENAI_MAX_OUTPUT_TOKENS_DEFAULT", "450")).strip())
    except Exception:
        default = 450
    try:
        hard = int(str(os.getenv("OPENAI_MAX_OUTPUT_TOKENS_HARD", "1800")).strip())
    except Exception:
        hard = 1800
    return concise_max_output_tokens(message, configured_default=default, configured_hard=hard)
