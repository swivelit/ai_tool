from __future__ import annotations

import os

from ..openai_model_router import OpenAIModelRouter
from .intent import IntentDecision, classify_intent_with_metadata, normalize_voice_query_for_intent
from .language import detect_language
from .prompts import concise_max_output_tokens
from .providers.sarvam_provider import chat_model_for_intent
from .types import AIRequest, AIRoute


class AIProviderRouter:
    def select_route(self, request: AIRequest) -> AIRoute:
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
        max_output_tokens = _max_output_tokens(request.message)

        if intent.intent == "unsafe_or_sensitive":
            return AIRoute(
                provider="blocked",
                model=None,
                route="safety_block",
                reason=intent.reason,
                language=language.language,
                intent=intent.intent,
                max_output_tokens=0,
                metadata=intent_metadata,
            )

        if intent.intent in {"weather", "live_data"}:
            if not _env_bool("ENABLE_WEB_SEARCH_FOR_FREE", False):
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

        if intent.route == "backend_tool":
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

        if language.prefer_provider == "sarvam" or intent.intent in {"translation", "tts", "stt", "contextual_translate", "contextual_explain"}:
            model = chat_model_for_intent(intent.intent)
            return AIRoute(
                provider="sarvam",
                model=model,
                route=f"sarvam_{intent.intent}",
                reason=f"{language.reason}:{intent.reason}",
                language=language.language,
                intent=intent.intent,
                max_output_tokens=max_output_tokens,
                needs_voice_output=request.channel == "voice",
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
            needs_voice_output=request.channel == "voice",
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
        hard = int(str(os.getenv("OPENAI_MAX_OUTPUT_TOKENS_HARD", "900")).strip())
    except Exception:
        hard = 900
    return concise_max_output_tokens(message, configured_default=default, configured_hard=hard)
