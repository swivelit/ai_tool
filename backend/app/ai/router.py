from __future__ import annotations

import os

from ..openai_model_router import OpenAIModelRouter
from .intent import classify_intent
from .language import detect_language
from .providers.sarvam_provider import chat_model_for_intent
from .types import AIRequest, AIRoute


class AIProviderRouter:
    def select_route(self, request: AIRequest) -> AIRoute:
        language = detect_language(request.message, request.reply_language)
        intent = classify_intent(request.message)
        max_output_tokens = _max_output_tokens()

        if intent.intent == "unsafe_or_sensitive":
            return AIRoute(
                provider="blocked",
                model=None,
                route="safety_block",
                reason=intent.reason,
                language=language.language,
                intent=intent.intent,
                max_output_tokens=0,
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
            )

        if language.prefer_provider == "sarvam" or intent.intent in {"translation", "tts", "stt"}:
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
            )

        openai_task = "coding" if intent.intent in {"coding", "complex_reasoning"} else "normal_qa"
        user_tier = str(request.metadata.get("user_tier") or request.metadata.get("tier") or "free")
        selections = OpenAIModelRouter().select_candidates(
            openai_task,
            request.message,
            route=intent.route,
            user_tier=user_tier,
        )
        selection = selections[0] if selections else OpenAIModelRouter().select_model(openai_task, request.message, route=intent.route)
        return AIRoute(
            provider="openai",
            model=selection.model,
            route=f"openai_{intent.intent}",
            reason=f"{intent.reason}:{selection.reason}",
            language=language.language,
            intent=intent.intent,
            max_output_tokens=selection.max_output_tokens,
            needs_voice_output=request.channel == "voice",
            model_candidates=[candidate.model for candidate in selections] or [selection.model],
            provider_endpoint_candidates=[candidate.endpoint for candidate in selections] or [selection.endpoint],
            metadata={"model_tier": selection.tier},
        )


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _max_output_tokens() -> int:
    try:
        default = int(str(os.getenv("OPENAI_MAX_OUTPUT_TOKENS_DEFAULT", "450")).strip())
    except Exception:
        default = 450
    try:
        hard = int(str(os.getenv("OPENAI_MAX_OUTPUT_TOKENS_HARD", "900")).strip())
    except Exception:
        hard = 900
    return max(1, min(default, hard))
