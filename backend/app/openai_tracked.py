from __future__ import annotations

import logging
import os
from typing import Any, Iterable, Optional

from sqlmodel import Session

from .openai_model_router import (
    OpenAIModelRouter,
    get_today_estimated_openai_spend,
    record_openai_usage,
)

logger = logging.getLogger(__name__)


class OpenAIBudgetExceededError(RuntimeError):
    """Raised before an OpenAI call when the configured daily budget is spent."""

    status_code = 503


def _messages_text(messages: Iterable[dict[str, Any]]) -> str:
    parts: list[str] = []
    for message in messages:
        role = str(message.get("role") or "").strip()
        content = message.get("content")
        if isinstance(content, list):
            content_text = " ".join(str(item.get("text") if isinstance(item, dict) else item) for item in content)
        else:
            content_text = str(content or "")
        parts.append(f"{role}: {content_text}".strip())
    return "\n".join(part for part in parts if part)


def _budget_usd() -> float:
    try:
        return max(0.0, float(str(os.getenv("OPENAI_DAILY_BUDGET_USD", "0")).strip() or 0.0))
    except Exception:
        return 0.0


def _session_context(session: Optional[Session]):
    if session is not None:
        return None, session
    from .database import SessionLocal

    created = SessionLocal()
    return created, created


def _check_budget_or_raise(
    usage_session: Session,
    *,
    route: str,
    model_used: str,
    model_tier: str,
    estimated_cost: float,
) -> None:
    budget = _budget_usd()
    if budget <= 0:
        return
    today_spend = get_today_estimated_openai_spend(usage_session)
    if today_spend + estimated_cost > budget:
        logger.warning(
            "openai_budget_exceeded",
            extra={
                "event": "openai_budget_exceeded",
                "route": route,
                "model_used": model_used,
                "model_tier": model_tier,
                "estimated_cost_usd": round(estimated_cost, 8),
                "today_estimated_spend_usd": round(today_spend, 8),
                "daily_budget_usd": budget,
                "today_spend": round(today_spend, 8),
                "estimated_cost": round(estimated_cost, 8),
                "budget": budget,
            },
        )
        raise OpenAIBudgetExceededError("OpenAI daily budget exceeded; cache-only response unavailable.")


def tracked_chat_completion(
    client: Any,
    *,
    messages: list[dict[str, Any]],
    task: str,
    route: str,
    session: Optional[Session] = None,
    user_id: Any = None,
    request_id: Optional[str] = None,
    risk_level: Optional[str] = None,
    needs_live_data: bool = False,
    temperature: Optional[float] = None,
    response_format: Optional[dict[str, Any]] = None,
    max_tokens: Optional[int] = None,
    **extra: Any,
) -> Any:
    """Route, budget-check, call, and log a Chat Completions request."""

    router = OpenAIModelRouter()
    prompt_text = _messages_text(messages)
    selection = router.select_model(
        task,
        prompt_text,
        risk_level=risk_level,
        needs_live_data=needs_live_data,
        route=route,
    )
    output_tokens = min(
        int(max_tokens or selection.max_output_tokens),
        int(selection.max_output_tokens),
        int(router.max_output_hard),
    )
    input_tokens = router.estimate_tokens(prompt_text)
    estimated_cost = router.estimate_cost(selection.model, input_tokens, output_tokens)

    owned_session, usage_session = _session_context(session)
    try:
        _check_budget_or_raise(
            usage_session,
            route=route,
            model_used=selection.model,
            model_tier=selection.tier,
            estimated_cost=estimated_cost,
        )

        request_kwargs: dict[str, Any] = {
            "model": selection.model,
            "messages": messages,
            "max_tokens": output_tokens,
            **extra,
        }
        if temperature is not None:
            request_kwargs["temperature"] = temperature
        if response_format is not None:
            request_kwargs["response_format"] = response_format

        response = client.chat.completions.create(**request_kwargs)
        record_openai_usage(
            usage_session,
            user_id=user_id,
            request_id=request_id,
            route=route,
            selection=selection,
            estimated_input_tokens=input_tokens,
            estimated_output_tokens=output_tokens,
            estimated_cost_usd=estimated_cost,
            cache_hit=False,
        )
        logger.info(
            "openai_usage_tracked",
            extra={
                "event": "openai_usage_tracked",
                "route": route,
                "model_used": selection.model,
                "model_tier": selection.tier,
                "reason": selection.reason,
                "estimated_input_tokens": input_tokens,
                "estimated_output_tokens": output_tokens,
                "estimated_cost_usd": round(estimated_cost, 8),
            },
        )
        return response
    finally:
        if owned_session is not None:
            owned_session.close()


def tracked_embedding(
    client: Any,
    *,
    input: list[str] | str,
    route: str,
    session: Optional[Session] = None,
    user_id: Any = None,
    request_id: Optional[str] = None,
    model: Optional[str] = None,
    **extra: Any,
) -> Any:
    """Budget-check, call, and log an OpenAI Embeddings request."""

    router = OpenAIModelRouter()
    embedding_model = (
        str(model or os.getenv("RAG_EMBEDDING_MODEL") or os.getenv("OPENAI_EMBEDDING_MODEL") or "").strip()
        or "text-embedding-3-small"
    )
    texts = input if isinstance(input, list) else [str(input or "")]
    prompt_text = "\n".join(str(text or "") for text in texts)
    input_tokens = router.estimate_tokens(prompt_text)
    estimated_cost = router.estimate_cost(embedding_model, input_tokens, 0)

    owned_session, usage_session = _session_context(session)
    try:
        _check_budget_or_raise(
            usage_session,
            route=route,
            model_used=embedding_model,
            model_tier="embedding",
            estimated_cost=estimated_cost,
        )
        response = client.embeddings.create(model=embedding_model, input=input, **extra)
        record_openai_usage(
            usage_session,
            user_id=user_id,
            request_id=request_id,
            route=route,
            model_used=embedding_model,
            model_tier="embedding",
            reason="embedding",
            estimated_input_tokens=input_tokens,
            estimated_output_tokens=0,
            estimated_cost_usd=estimated_cost,
            cache_hit=False,
        )
        logger.info(
            "openai_usage_tracked",
            extra={
                "event": "openai_usage_tracked",
                "route": route,
                "model_used": embedding_model,
                "model_tier": "embedding",
                "reason": "embedding",
                "estimated_input_tokens": input_tokens,
                "estimated_output_tokens": 0,
                "estimated_cost_usd": round(estimated_cost, 8),
            },
        )
        return response
    finally:
        if owned_session is not None:
            owned_session.close()
