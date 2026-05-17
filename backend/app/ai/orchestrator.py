from __future__ import annotations

import time
import re
from typing import Any, Optional

from fastapi import HTTPException
from sqlmodel import Session

from .budget import enforce_free_text_quota, enforce_provider_budget
from .openai_catalog import get_model_spec
from .providers.openai_provider import OpenAIProvider
from .providers.sarvam_provider import SarvamProvider
from .router import AIProviderRouter
from .tools import handle_backend_tool
from .types import AIProviderResponse, AIRequest, AIRoute
from .usage import record_ai_usage_event


def run_text_turn(
    session: Session,
    ai_request: AIRequest,
    *,
    existing_context: Optional[dict[str, Any]] = None,
) -> AIProviderResponse:
    context = existing_context or {}
    started = time.perf_counter()
    enforce_free_text_quota(
        session,
        ai_request.user_id,
        admin_email=str(ai_request.metadata.get("admin_email") or ""),
    )

    route = context.get("router", AIProviderRouter()).select_route(ai_request)
    if route.provider == "blocked":
        response = _blocked_response(ai_request, route)
        return _record(session, response, ai_request, started)

    if route.provider == "backend_tool":
        response = handle_backend_tool(session, ai_request, route)
        return _record(session, response, ai_request, started)

    cached = _try_global_cache(session, ai_request, context)
    if cached is not None:
        return _record(session, cached, ai_request, started, cache_hit=True, metadata={"embedding_calls": context.get("embedding_calls", 0)})

    local = _try_local_rag(session, ai_request, route, context)
    if local is not None:
        return _record(session, local, ai_request, started, cache_hit=True, metadata={"embedding_calls": context.get("embedding_calls", 0)})

    response, metadata = _complete_with_controlled_fallback(session, ai_request, route, context)
    metadata.setdefault("embedding_calls", context.get("embedding_calls", 0))
    response.raw.setdefault("embedding_calls", metadata.get("embedding_calls", 0))
    return _record(session, response, ai_request, started, metadata=metadata)


def _provider_for_route(route: AIRoute, context: dict[str, Any]):
    if route.provider == "sarvam":
        return context.get("sarvam_provider") or SarvamProvider()
    if route.provider == "openai":
        return context.get("openai_provider") or OpenAIProvider()
    raise RuntimeError(f"Unsupported provider route: {route.provider}")


def _record(
    session: Session,
    response: AIProviderResponse,
    request: AIRequest,
    started: float,
    *,
    cache_hit: bool = False,
    metadata: Optional[dict[str, Any]] = None,
) -> AIProviderResponse:
    latency_ms = int(round((time.perf_counter() - started) * 1000))
    record_ai_usage_event(
        session,
        response,
        user_id=request.user_id,
        request_id=request.request_id,
        cache_hit=cache_hit,
        latency_ms=latency_ms,
        metadata={
            "channel": request.channel,
            **dict(request.metadata or {}),
            **dict(metadata or {}),
        },
    )
    return response


def _complete_with_controlled_fallback(
    session: Session,
    request: AIRequest,
    route: AIRoute,
    context: dict[str, Any],
) -> tuple[AIProviderResponse, dict[str, Any]]:
    request_for_provider = AIRequest(
        user_id=request.user_id,
        message=request.message,
        reply_language=request.reply_language,
        channel=request.channel,
        request_id=request.request_id,
        metadata={**request.metadata, "session": session},
    )
    try:
        return _call_provider(session, request_for_provider, route, context), {}
    except Exception as exc:
        if _is_budget_or_quota_exception(exc):
            raise
        primary_error_type = _provider_error_type(exc)
        fallback_route = _fallback_route(route, request, context)
        error_metadata = _exception_metadata(exc)
        metadata = {
            "primary_provider": route.provider,
            "primary_model": route.model,
            "primary_error_type": primary_error_type,
            "fallback_attempted": fallback_route is not None,
            "fallback_provider": fallback_route.provider if fallback_route else "",
            **error_metadata,
        }
        if fallback_route is None:
            return _provider_unavailable_response(route, primary_error_type, error_metadata), metadata
        try:
            response = _call_provider(session, request_for_provider, fallback_route, context)
            response.reason = f"{response.reason}:fallback_after_{route.provider}_{primary_error_type}"
            response.raw.setdefault("fallback", metadata)
            return response, metadata
        except Exception as fallback_exc:
            if _is_budget_or_quota_exception(fallback_exc):
                raise
            metadata["fallback_error_type"] = _provider_error_type(fallback_exc)
            metadata.update(_exception_metadata(fallback_exc))
            return _provider_unavailable_response(route, primary_error_type, metadata), metadata


def _call_provider(
    session: Session,
    request: AIRequest,
    route: AIRoute,
    context: dict[str, Any],
) -> AIProviderResponse:
    enforce_provider_budget(session, route.provider, currency="INR" if route.provider == "sarvam" else "USD")
    return _provider_for_route(route, context).complete(request, route)


def _fallback_route(route: AIRoute, request: AIRequest, context: dict[str, Any]) -> Optional[AIRoute]:
    if _max_provider_calls_hard(context) < 2:
        return None
    if route.intent == "unsafe_or_sensitive" or route.route == "live_data_disabled":
        return None
    if route.provider == "sarvam":
        model = "gpt-5-mini" if route.intent in {"coding", "complex_reasoning"} else "gpt-5-nano"
        from ..openai_model_router import OpenAIModelRouter

        task = "coding" if route.intent in {"coding", "complex_reasoning"} else "normal_qa"
        selections = OpenAIModelRouter().select_candidates(task, request.message, route=route.route)
        return AIRoute(
            provider="openai",
            model=selections[0].model if selections else model,
            route=f"openai_fallback_for_{route.intent}",
            reason=f"sarvam_failed_fallback_to_openai_answer_in_{request.reply_language or route.language}",
            language=route.language,
            intent=route.intent,
            max_output_tokens=route.max_output_tokens,
            needs_voice_output=route.needs_voice_output,
            model_candidates=[selection.model for selection in selections] or [model],
            provider_endpoint_candidates=[selection.endpoint for selection in selections] or [get_model_spec(model).endpoint],
        )
    if route.provider == "openai":
        if route.intent in {"coding", "complex_reasoning"} and not _env_bool("AI_ALLOW_SARVAM_COMPLEX_FALLBACK", False):
            return None
        if not _env_bool("AI_ALLOW_OPENAI_TO_SARVAM_FALLBACK", False):
            return None
        if not _sarvam_configured(context):
            return None
        return AIRoute(
            provider="sarvam",
            model="sarvam-30b",
            route=f"sarvam_fallback_for_{route.intent}",
            reason="openai_failed_fallback_to_sarvam",
            language=route.language,
            intent=route.intent,
            max_output_tokens=route.max_output_tokens,
            needs_voice_output=route.needs_voice_output,
        )
    return None


def _provider_unavailable_response(
    route: AIRoute,
    error_type: str,
    error_metadata: Optional[dict[str, Any]] = None,
) -> AIProviderResponse:
    text = "The selected AI provider is temporarily unavailable. Please try again shortly."
    if route.provider == "openai" and route.intent in {"coding", "complex_reasoning"}:
        text = "The reasoning provider is temporarily unavailable. Please try again shortly."
    return AIProviderResponse(
        text=text,
        provider="blocked",
        model=None,
        route=f"{route.provider}_provider_unavailable",
        reason=f"{route.provider}_provider_error:{error_type}",
        language=route.language,
        intent=route.intent,
        characters=len(text),
        raw={
            "primary_provider": route.provider,
            "primary_model": route.model,
            "primary_error_type": error_type,
            "provider_error_type": (error_metadata or {}).get("provider_error_type") or error_type,
            "model_candidates": route.model_candidates,
            **dict(error_metadata or {}),
        },
    )


def _provider_error_type(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        return f"http_{exc.status_code}"
    metadata = getattr(exc, "metadata", None)
    if isinstance(metadata, dict) and metadata.get("provider_error_type"):
        return str(metadata.get("provider_error_type"))
    return exc.__class__.__name__


def _exception_metadata(exc: Exception) -> dict[str, Any]:
    metadata = getattr(exc, "metadata", None)
    if not isinstance(metadata, dict):
        return {}
    safe: dict[str, Any] = {}
    for key in (
        "attempted_models",
        "model_candidates",
        "provider_error_type",
        "fallback_attempted",
        "errors",
    ):
        if key in metadata:
            safe[key] = metadata[key]
    return safe


def _is_budget_or_quota_exception(exc: Exception) -> bool:
    if exc.__class__.__name__ == "OpenAIBudgetExceededError":
        return True
    if not isinstance(exc, HTTPException):
        return False
    detail = str(exc.detail or "").lower()
    return "budget exceeded" in detail or "daily free" in detail or "limit reached" in detail


def _max_provider_calls_hard(context: dict[str, Any]) -> int:
    value = context.get("max_provider_calls_hard")
    if value is None:
        import os

        value = os.getenv("AI_MAX_PROVIDER_CALLS_PER_TURN_HARD", "2")
    try:
        return max(1, int(str(value).strip()))
    except Exception:
        return 2


def _env_bool(name: str, default: bool = False) -> bool:
    import os

    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _sarvam_configured(context: dict[str, Any]) -> bool:
    provider = context.get("sarvam_provider")
    if provider is not None and getattr(provider, "_client", None) is not None:
        return True
    import os

    return bool(os.getenv("SARVAM_API_KEY", "").strip())


def _try_global_cache(session: Session, request: AIRequest, context: dict[str, Any]) -> Optional[AIProviderResponse]:
    lookup = context.get("global_cache_lookup")
    if lookup is None:
        try:
            from ..global_qa_cache import lookup_approved_global_cache

            lookup = lookup_approved_global_cache
        except Exception:
            lookup = None
    if lookup is None:
        return None
    try:
        hit = lookup(session, request.message, request.reply_language)
    except Exception:
        session.rollback()
        return None
    if not hit:
        return None
    text = str(hit.get("answer") or "").strip()
    if not text:
        return None
    return AIProviderResponse(
        text=text,
        provider="cache",
        model=None,
        route="global_knowledge_cache",
        reason="approved_global_cache_hit",
        language=str(hit.get("answer_language") or "en"),
        intent="general",
        characters=len(text),
        raw={"source": "global_qa_cache", "global_cache_id": hit.get("id"), "confidence": hit.get("confidence")},
    )


def _try_local_rag(
    session: Session,
    request: AIRequest,
    route: AIRoute,
    context: dict[str, Any],
) -> Optional[AIProviderResponse]:
    if not _should_run_local_rag(request, route, context):
        context["embedding_calls"] = int(context.get("embedding_calls") or 0)
        return None
    service = context.get("local_rag_service")
    if service is None:
        return None
    if int(context.get("embedding_calls") or 0) >= _max_embedding_calls_per_turn():
        return None
    context["embedding_calls"] = int(context.get("embedding_calls") or 0) + 1
    try:
        hit = service.try_answer(session, request.user_id, request.message)
    except Exception:
        session.rollback()
        return None
    if not isinstance(hit, dict):
        return None
    confidence = float(hit.get("direct_answer_confidence") or 0.0)
    if confidence < 0.90:
        return None
    text = str(hit.get("theni_tamil_text") or hit.get("tamil_text") or hit.get("remodeled_english") or hit.get("raw_english") or "").strip()
    if not text:
        return None
    return AIProviderResponse(
        text=text,
        provider="cache",
        model=hit.get("model_used"),
        route=str(hit.get("route_taken") or "local_rag_cache"),
        reason="local_rag_high_confidence_hit",
        language="ta" if hit.get("tamil_text") or hit.get("theni_tamil_text") else "en",
        intent=str(hit.get("predicted_label") or "general"),
        characters=len(text),
        raw={"source": hit.get("direct_answer_source"), "confidence": confidence, "embedding_calls": context.get("embedding_calls", 0)},
    )


def _should_run_local_rag(request: AIRequest, route: AIRoute, context: dict[str, Any]) -> bool:
    if not _env_bool("AI_SEMANTIC_CACHE_LOOKUP_ENABLED", True):
        return False
    if context.get("force_rag_lookup"):
        return True
    if _env_bool("AI_EMBEDDINGS_ON_EVERY_TURN", False):
        return True
    message = str(request.message or "").lower()
    simple = route.provider == "openai" and route.intent in {"general", "greeting"}
    rag_terms = bool(
        re.search(
            r"\b(saved|memory|profile|document|documents|doc|docs|file|files|pdf|note|notes|knowledge|"
            r"according to|what did i|my previous|my saved|uploaded)\b",
            message,
        )
    )
    if simple and not rag_terms:
        return _env_bool("AI_RAG_LOOKUP_FOR_SIMPLE_CHAT", False) or _env_bool(
            "AI_SEMANTIC_CACHE_LOOKUP_FOR_SIMPLE_CHAT",
            False,
        )
    return rag_terms


def _max_embedding_calls_per_turn() -> int:
    import os

    try:
        return max(0, int(str(os.getenv("AI_MAX_EMBEDDING_CALLS_PER_TURN", "1")).strip()))
    except Exception:
        return 1


def _blocked_response(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    if route.intent in {"weather", "live_data"}:
        text = (
            "I cannot fetch live or current data from this free route right now. "
            "Please connect a live data provider or ask a stable background question."
        )
    elif route.intent == "unsafe_or_sensitive":
        text = (
            "I cannot provide high-risk medical, legal, financial, or emergency instructions here. "
            "For emergencies, contact local emergency services immediately."
        )
    else:
        text = "I cannot complete that request from this route."
    return AIProviderResponse(
        text=text,
        provider="blocked",
        model=None,
        route=route.route,
        reason=route.reason,
        language=route.language,
        intent=route.intent,
        characters=len(text),
    )
