from __future__ import annotations

import time
from typing import Any, Optional

from sqlmodel import Session

from .budget import enforce_free_text_quota, enforce_provider_budget
from .providers.openai_provider import OpenAIProvider
from .providers.sarvam_provider import SarvamProvider
from .router import AIProviderRouter
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

    cached = _try_global_cache(session, ai_request, context)
    if cached is not None:
        return _record(session, cached, ai_request, started, cache_hit=True)

    local = _try_local_rag(session, ai_request, context)
    if local is not None:
        return _record(session, local, ai_request, started, cache_hit=True)

    route = context.get("router", AIProviderRouter()).select_route(ai_request)
    if route.provider == "backend_tool":
        response = _backend_tool_response(ai_request, route)
        return _record(session, response, ai_request, started)

    if route.provider == "blocked":
        response = _blocked_response(ai_request, route)
        return _record(session, response, ai_request, started)

    enforce_provider_budget(session, route.provider, currency="INR" if route.provider == "sarvam" else "USD")

    provider = _provider_for_route(route, context)
    response = provider.complete(
        AIRequest(
            user_id=ai_request.user_id,
            message=ai_request.message,
            reply_language=ai_request.reply_language,
            channel=ai_request.channel,
            request_id=ai_request.request_id,
            metadata={**ai_request.metadata, "session": session},
        ),
        route,
    )
    return _record(session, response, ai_request, started)


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
        },
    )
    return response


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


def _try_local_rag(session: Session, request: AIRequest, context: dict[str, Any]) -> Optional[AIProviderResponse]:
    service = context.get("local_rag_service")
    if service is None:
        return None
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
        raw={"source": hit.get("direct_answer_source"), "confidence": confidence},
    )


def _backend_tool_response(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    message = str(request.message or "").strip()
    if route.intent == "reminder":
        if "what" in message.lower() or len(message.split()) <= 6:
            text = "What should I remind you about?"
        else:
            text = "I can save that reminder from your app tools without calling an AI model."
    elif route.intent == "routine":
        text = "I can use your saved routine from the backend tools for this."
    elif route.intent == "profile":
        text = "I can answer that from your saved profile and memory."
    elif route.intent == "settings":
        text = "I can update that setting from the backend tools."
    else:
        text = "I can handle that with a backend tool."
    return AIProviderResponse(
        text=text,
        provider="backend_tool",
        model=None,
        route=route.route,
        reason=route.reason,
        language=route.language,
        intent=route.intent,
        characters=len(text),
    )


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
