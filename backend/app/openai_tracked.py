from __future__ import annotations

import logging
import os
import re
import hashlib
import json
import threading
import time
from typing import Any, Iterable, Optional

from sqlmodel import Session

from .ai.model_health import is_model_temporarily_unavailable, mark_model_unavailable
from .ai.openai_catalog import OpenAIModelSpec, get_model_spec
from .ai.openai_reasoning import openai_web_reasoning_effort
from .openai_model_router import (
    ModelSelection,
    OpenAIModelRouter,
    get_today_estimated_openai_spend,
    record_openai_usage,
)

logger = logging.getLogger(__name__)


class OpenAIBudgetExceededError(RuntimeError):
    """Raised before an OpenAI call when the configured daily budget is spent."""

    status_code = 503


class OpenAIProviderUnavailableError(RuntimeError):
    """Raised after all allowed OpenAI generation candidates fail."""

    status_code = 503

    def __init__(self, message: str, *, metadata: Optional[dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.metadata = dict(metadata or {})


TRACKED_METADATA_ATTR = "_openai_tracked_metadata"
_EMBEDDING_TURN_CACHE: dict[tuple[str, str, str], tuple[float, Any]] = {}
_TEXT_EMBEDDING_CACHE: dict[str, tuple[float, list[float]]] = {}
_TEXT_EMBEDDING_CACHE_LOCK = threading.Lock()


def get_tracked_chat_completion_metadata(response: Any) -> dict[str, Any]:
    metadata = getattr(response, TRACKED_METADATA_ATTR, None)
    return dict(metadata) if isinstance(metadata, dict) else {}


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


def _budget_safety_margin_ratio() -> float:
    try:
        return max(0.0, float(str(os.getenv("OPENAI_BUDGET_SAFETY_MARGIN_RATIO", "0.05")).strip() or 0.0))
    except Exception:
        return 0.05


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
    guarded_estimated_cost = estimated_cost * (1.0 + _budget_safety_margin_ratio())
    if today_spend + guarded_estimated_cost > budget:
        logger.warning(
            "openai_budget_exceeded",
            extra={
                "event": "openai_budget_exceeded",
                "route": route,
                "model_used": model_used,
                "model_tier": model_tier,
                "estimated_cost_usd": round(estimated_cost, 8),
                "guarded_estimated_cost_usd": round(guarded_estimated_cost, 8),
                "today_estimated_spend_usd": round(today_spend, 8),
                "daily_budget_usd": budget,
                "today_spend": round(today_spend, 8),
                "estimated_cost": round(estimated_cost, 8),
                "budget": budget,
            },
        )
        raise OpenAIBudgetExceededError("OpenAI daily budget exceeded; cache-only response unavailable.")


def enforce_openai_budget(
    session: Optional[Session], *, route: str, model: str, model_tier: str,
    estimated_cost_usd: float,
) -> None:
    """Apply the same daily budget guard to streaming and non-streaming calls."""
    owned_session, usage_session = _session_context(session)
    try:
        _check_budget_or_raise(
            usage_session,
            route=route,
            model_used=model,
            model_tier=model_tier,
            estimated_cost=estimated_cost_usd,
        )
    finally:
        if owned_session is not None:
            owned_session.close()


def _usage_int(usage: Any, *names: str) -> Optional[int]:
    for name in names:
        if isinstance(usage, dict):
            value = usage.get(name)
        else:
            value = getattr(usage, name, None)
        if value is None:
            continue
        try:
            return max(0, int(value))
        except Exception:
            continue
    return None


def _usage_metadata(router: OpenAIModelRouter, model: str, response: Any) -> dict[str, Any]:
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return {}
    input_tokens = _usage_int(usage, "prompt_tokens", "input_tokens")
    output_tokens = _usage_int(usage, "completion_tokens", "output_tokens")
    total_tokens = _usage_int(usage, "total_tokens")
    details = (
        getattr(usage, "prompt_tokens_details", None)
        or getattr(usage, "input_tokens_details", None)
    )
    if details is None and isinstance(usage, dict):
        details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details")
    output_details = getattr(usage, "output_tokens_details", None)
    if output_details is None and isinstance(usage, dict):
        output_details = usage.get("output_tokens_details")
    cached_input_tokens = _usage_int(details, "cached_tokens") if details is not None else None
    cache_write_tokens = (
        _usage_int(details, "cache_write_tokens", "cache_creation_input_tokens")
        if details is not None else None
    )
    reasoning_tokens = (
        _usage_int(output_details, "reasoning_tokens")
        if output_details is not None else None
    )
    if output_tokens is None and input_tokens is not None and total_tokens is not None:
        output_tokens = max(0, total_tokens - input_tokens)
    metadata: dict[str, Any] = {}
    if input_tokens is not None:
        metadata["actual_input_tokens"] = input_tokens
    if output_tokens is not None:
        metadata["actual_output_tokens"] = output_tokens
    if cached_input_tokens is not None:
        metadata["cached_input_tokens"] = cached_input_tokens
    if cache_write_tokens is not None:
        metadata["cache_write_tokens"] = cache_write_tokens
    if reasoning_tokens is not None:
        metadata["reasoning_tokens"] = reasoning_tokens
    if input_tokens is not None or output_tokens is not None:
        metadata["actual_cost_usd"] = router.estimate_cost(
            model, input_tokens or 0, output_tokens or 0,
            cached_input_tokens or 0, cache_write_tokens or 0,
        )
    return metadata


def _attach_metadata(response: Any, metadata: dict[str, Any]) -> Any:
    try:
        setattr(response, TRACKED_METADATA_ATTR, metadata)
        return response
    except Exception:
        pass
    try:
        object.__setattr__(response, TRACKED_METADATA_ATTR, metadata)
    except Exception:
        logger.debug("Could not attach OpenAI tracking metadata to response", exc_info=True)
    return response


def _selected_model_reason(
    *,
    index: int,
    errors: list[dict[str, Any]],
    skipped_models: list[dict[str, Any]],
    default_reason: str,
) -> str:
    if index <= 0 and not skipped_models and not errors:
        return "cost_optimizer_choice"
    if skipped_models and str(skipped_models[0].get("reason") or "") == "primary_model_health_cache":
        return "primary_model_health_cache"
    if errors:
        first = errors[0]
        if str(first.get("error_type") or "") == "model_health_skip":
            return "primary_model_health_cache"
        status = first.get("status_code")
        try:
            status_int = int(status) if status is not None else 0
        except Exception:
            status_int = 0
        if status_int in {401, 403, 404}:
            return "primary_model_access_error"
        if status_int == 400:
            return "primary_model_endpoint_error"
        return "primary_model_unavailable"
    return default_reason or "cost_optimizer_choice"


def _model_health_skip_reason(skipped_models: list[dict[str, Any]]) -> str:
    for skipped in skipped_models:
        reason = str(skipped.get("reason") or "")
        if "health_cache" in reason:
            return reason
    return ""


def _sanitize_openai_error_message(value: Any, *, limit: int = 240) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"sk-[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)(api[_-]?key\s*[:=]\s*)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", text)
    return text[:limit]


def _error_status_code(exc: Exception) -> Optional[int]:
    for name in ("status_code", "status"):
        value = getattr(exc, name, None)
        if value is not None:
            try:
                return int(value)
            except Exception:
                pass
    response = getattr(exc, "response", None)
    value = getattr(response, "status_code", None)
    if value is not None:
        try:
            return int(value)
        except Exception:
            pass
    return None


def _error_code(exc: Exception) -> str:
    code = getattr(exc, "code", None)
    if code:
        return str(code)
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("code"):
            return str(err.get("code"))
    return ""


def _error_type(exc: Exception) -> str:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("type"):
            return str(err.get("type"))
    return exc.__class__.__name__


def _is_budget_exception(exc: Exception) -> bool:
    return isinstance(exc, OpenAIBudgetExceededError)


def _health_ttl_for_error(exc: Exception) -> Optional[int]:
    status = _error_status_code(exc)
    if status == 400 or status == 404 or status == 403:
        try:
            return max(1, int(str(os.getenv("OPENAI_MODEL_PROBE_CACHE_TTL_SECONDS", "900")).strip()))
        except Exception:
            return 900
    if status in {429, 500, 502, 503, 504}:
        return 60
    return None


def _candidate_from_any(value: Any, router: OpenAIModelRouter, prompt_text: str, max_output_tokens: Optional[int]) -> ModelSelection:
    if isinstance(value, ModelSelection):
        return value
    if isinstance(value, dict):
        model = str(value.get("model") or "").strip()
        tier = str(value.get("tier") or get_model_spec(model).tier)
        endpoint = str(value.get("endpoint") or get_model_spec(model).endpoint)
        output_tokens = int(value.get("max_output_tokens") or max_output_tokens or router.max_output_default)
        input_tokens = router.estimate_tokens(prompt_text)
        return ModelSelection(
            model=model,
            tier=tier,
            reason=str(value.get("reason") or "explicit_candidate"),
            max_output_tokens=min(output_tokens, router.max_output_hard),
            endpoint=endpoint,
            estimated_input_tokens=input_tokens,
            estimated_output_tokens=min(output_tokens, router.max_output_hard),
            estimated_cost_usd=router.estimate_cost(model, input_tokens, min(output_tokens, router.max_output_hard)),
        )
    model = str(value or "").strip()
    spec = get_model_spec(model)
    output_tokens = int(max_output_tokens or router.max_output_default)
    input_tokens = router.estimate_tokens(prompt_text)
    return ModelSelection(
        model=model,
        tier=spec.tier,
        reason="explicit_candidate",
        max_output_tokens=min(output_tokens, router.max_output_hard),
        endpoint=spec.endpoint,
        estimated_input_tokens=input_tokens,
        estimated_output_tokens=min(output_tokens, router.max_output_hard),
        estimated_cost_usd=router.estimate_cost(model, input_tokens, min(output_tokens, router.max_output_hard)),
    )


def _response_output_text(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
    if output_text is None and isinstance(response, dict):
        output_text = response.get("output_text")
    if output_text:
        return str(output_text).strip()
    output = getattr(response, "output", None)
    if output is None and isinstance(response, dict):
        output = response.get("output")
    parts: list[str] = []
    for item in output or []:
        content = getattr(item, "content", None)
        if content is None and isinstance(item, dict):
            content = item.get("content")
        for block in content or []:
            text = getattr(block, "text", None)
            if text is None and isinstance(block, dict):
                text = block.get("text")
            if text:
                parts.append(str(text))
    return "\n".join(part.strip() for part in parts if part and part.strip()).strip()


def _chat_output_text(response: Any) -> str:
    try:
        if hasattr(response, "choices") and response.choices:
            return str(response.choices[0].message.content or "").strip()
    except Exception:
        return ""
    return ""


def _build_responses_input(messages: list[dict[str, Any]], input_text: Optional[str]) -> str:
    if input_text is not None:
        return str(input_text or "")
    parts: list[str] = []
    for message in messages:
        role = str(message.get("role") or "user")
        if role in {"system", "developer"}:
            continue
        content = message.get("content")
        if isinstance(content, list):
            content_text = " ".join(str(item.get("text") if isinstance(item, dict) else item) for item in content)
        else:
            content_text = str(content or "")
        if content_text.strip():
            parts.append(content_text.strip())
    return "\n".join(parts).strip()


def _build_instructions(messages: list[dict[str, Any]], instructions: Optional[str]) -> str:
    if instructions:
        return str(instructions or "")
    parts: list[str] = []
    for message in messages:
        if str(message.get("role") or "") in {"system", "developer"}:
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                parts.append(content.strip())
    return "\n\n".join(parts)


def tracked_openai_generation(
    client: Any,
    *,
    messages: list[dict[str, Any]],
    input_text: Optional[str] = None,
    instructions: Optional[str] = None,
    task: str,
    route: str,
    candidates: Optional[list[Any]] = None,
    session: Optional[Session] = None,
    user_id: Any = None,
    request_id: Optional[str] = None,
    risk_level: Optional[str] = None,
    needs_live_data: bool = False,
    max_output_tokens: Optional[int] = None,
    response_format: Optional[dict[str, Any]] = None,
    temperature: Optional[float] = None,
    max_provider_attempts: Optional[int] = None,
    estimated_input_tokens: Optional[int] = None,
    **extra: Any,
) -> Any:
    """Generate text with Responses or Chat Completions using an ordered ladder."""

    router = OpenAIModelRouter()
    prompt_text = input_text if input_text is not None else _messages_text(messages)
    if candidates:
        selections = [_candidate_from_any(candidate, router, prompt_text, max_output_tokens) for candidate in candidates]
    else:
        selections = router.select_candidates(
            task,
            prompt_text,
            risk_level=risk_level,
            needs_live_data=needs_live_data,
            route=route,
        )
    selections = [selection for selection in selections if selection.model]
    if not selections:
        selections = [router.select_model(task, prompt_text, risk_level=risk_level, needs_live_data=needs_live_data, route=route)]

    owned_session, usage_session = _session_context(session)
    attempted_models: list[str] = []
    errors: list[dict[str, Any]] = []
    skipped_models: list[dict[str, Any]] = []
    primary_model_candidate = selections[0].model if selections else ""
    try:
        for index, selection in enumerate(selections):
            spec = get_model_spec(selection.model)
            endpoint = str(selection.endpoint or spec.endpoint)
            if is_model_temporarily_unavailable("openai", selection.model, endpoint):
                skip_reason = "primary_model_health_cache" if index == 0 else "model_health_cache"
                skipped_models.append(
                    {
                        "model": selection.model,
                        "endpoint": endpoint,
                        "reason": skip_reason,
                    }
                )
                errors.append(
                    {
                        "model": selection.model,
                        "endpoint": endpoint,
                        "error_type": "model_health_skip",
                        "status_code": None,
                    }
                )
                continue

            if len(attempted_models) >= min(2, max(1, int(max_provider_attempts or len(selections) or 1))):
                break

            output_tokens = min(
                int(max_output_tokens or selection.max_output_tokens),
                int(selection.max_output_tokens),
                int(router.max_output_hard),
            )
            input_tokens = max(1, int(estimated_input_tokens or router.estimate_tokens(prompt_text)))
            estimated_cost = router.estimate_cost(selection.model, input_tokens, output_tokens)
            _check_budget_or_raise(
                usage_session,
                route=route,
                model_used=selection.model,
                model_tier=selection.tier,
                estimated_cost=estimated_cost,
            )
            attempted_models.append(selection.model)
            try:
                if endpoint == "responses":
                    answer_class = extra.get("answer_class")
                    reasoning_effort = openai_web_reasoning_effort(answer_class)
                    request_kwargs: dict[str, Any] = {
                        "model": selection.model,
                        "input": _build_responses_input(messages, input_text),
                        "instructions": _build_instructions(messages, instructions),
                        "max_output_tokens": output_tokens,
                        "store": False,
                    }
                    if spec.supports_reasoning_effort:
                        if reasoning_effort is not None:
                            request_kwargs["reasoning"] = {
                                "effort": reasoning_effort
                            }
                        elif selection.tier in {"reasoning", "hard_reasoning"}:
                            # Preserve the pre-existing policy for callers that
                            # do not provide a website answer classification.
                            request_kwargs["reasoning"] = {"effort": "low"}
                    if temperature is not None and spec.supports_temperature:
                        request_kwargs["temperature"] = temperature
                    if extra.get("prompt_cache_key"):
                        request_kwargs["prompt_cache_key"] = str(
                            extra["prompt_cache_key"]
                        )
                    response = client.responses.create(**request_kwargs)
                else:
                    request_kwargs = {
                        "model": selection.model,
                        "messages": messages,
                        "store": False,
                    }
                    token_param = "max_completion_tokens" if selection.model.startswith(("gpt-5", "o")) else "max_tokens"
                    request_kwargs[token_param] = output_tokens
                    if temperature is not None and spec.supports_temperature:
                        request_kwargs["temperature"] = temperature
                    if response_format is not None and spec.supports_response_format:
                        request_kwargs["response_format"] = response_format
                    if extra.get("prompt_cache_key"):
                        request_kwargs["prompt_cache_key"] = str(
                            extra["prompt_cache_key"]
                        )
                    response = client.chat.completions.create(**request_kwargs)
            except Exception as exc:
                if _is_budget_exception(exc):
                    raise
                status_code = _error_status_code(exc)
                error_type = _error_type(exc)
                error_code = _error_code(exc)
                error_message = _sanitize_openai_error_message(exc)
                logger.warning(
                    "openai_provider_error",
                    extra={
                        "event": "openai_provider_error",
                        "status_code": status_code,
                        "error_type": error_type,
                        "error_code": error_code,
                        "model": selection.model,
                        "endpoint": endpoint,
                        "request_id": request_id,
                    },
                )
                ttl = _health_ttl_for_error(exc)
                if ttl:
                    mark_model_unavailable("openai", selection.model, endpoint, error_type, ttl)
                errors.append(
                    {
                        "model": selection.model,
                        "endpoint": endpoint,
                        "status_code": status_code,
                        "error_type": error_type,
                        "error_code": error_code,
                        "error_message_sanitized": error_message,
                    }
                )
                # Provider ladders may fail over only when the failed request
                # produced neither output nor reportable usage.
                exc_response = getattr(exc, "response", None)
                if _response_output_text(exc_response) or _chat_output_text(exc_response) or _usage_metadata(router, selection.model, exc_response):
                    raise
                continue

            actual_metadata = _usage_metadata(router, selection.model, response)
            actual_input = actual_metadata.get("actual_input_tokens")
            actual_output = actual_metadata.get("actual_output_tokens")
            actual_cost = actual_metadata.get("actual_cost_usd")
            selected_model_reason = _selected_model_reason(
                index=index,
                errors=errors,
                skipped_models=skipped_models,
                default_reason=selection.reason,
            )
            metadata = {
                "model_used": selection.model,
                "model_tier": selection.tier,
                "endpoint": endpoint,
                "reason": selection.reason,
                "candidate_index": index,
                "fallback_attempted": len(attempted_models) > 1,
                "provider_attempts": len(attempted_models),
                "provider_calls_with_usage": 1 if actual_metadata else 0,
                "attempted_models": list(attempted_models),
                "model_candidates": [candidate.model for candidate in selections],
                "primary_model_candidate": primary_model_candidate,
                "selected_model_reason": selected_model_reason,
                "skipped_models": list(skipped_models),
                "model_health_skip_reason": _model_health_skip_reason(skipped_models),
                "estimated_input_tokens": input_tokens,
                "estimated_output_tokens": output_tokens,
                "estimated_cost_usd": estimated_cost,
                "reasoning_effort": (
                    reasoning_effort
                    if endpoint == "responses"
                    and spec.supports_reasoning_effort
                    else None
                ),
                **actual_metadata,
            }
            record_openai_usage(
                usage_session,
                user_id=user_id,
                request_id=request_id,
                route=route,
                selection=selection,
                reason=selected_model_reason,
                estimated_input_tokens=input_tokens,
                estimated_output_tokens=output_tokens,
                estimated_cost_usd=estimated_cost,
                actual_input_tokens=actual_input,
                actual_output_tokens=actual_output,
                actual_cost_usd=actual_cost,
                cache_hit=False,
            )
            logger.info(
                "openai_usage_tracked",
                extra={
                    "event": "openai_usage_tracked",
                    "route": route,
                    "model_used": selection.model,
                    "model_tier": selection.tier,
                    "endpoint": endpoint,
                    "reason": selection.reason,
                    "selected_model_reason": selected_model_reason,
                    "primary_model_candidate": primary_model_candidate,
                    "model_health_skip_reason": _model_health_skip_reason(skipped_models),
                    "estimated_input_tokens": input_tokens,
                    "estimated_output_tokens": output_tokens,
                    "estimated_cost_usd": round(estimated_cost, 8),
                    "actual_input_tokens": actual_input,
                    "actual_output_tokens": actual_output,
                    "actual_cost_usd": round(float(actual_cost or 0.0), 8) if actual_cost is not None else None,
                },
            )
            return _attach_metadata(response, metadata)
    finally:
        if owned_session is not None:
            owned_session.close()

    raise OpenAIProviderUnavailableError(
        "OpenAI generation failed for all allowed candidates.",
        metadata={
            "attempted_models": attempted_models,
            "model_candidates": [selection.model for selection in selections],
            "errors": errors,
            "provider_error_type": errors[-1]["error_type"] if errors else "no_candidate_available",
            "fallback_attempted": len(attempted_models) > 1,
            "provider_attempts": len(attempted_models),
            "primary_model_candidate": primary_model_candidate,
            "selected_model_reason": _selected_model_reason(
                index=max(0, len(attempted_models) - 1),
                errors=errors,
                skipped_models=skipped_models,
                default_reason="primary_model_unavailable",
            ),
            "skipped_models": skipped_models,
            "model_health_skip_reason": _model_health_skip_reason(skipped_models),
        },
    )


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
    forced_model_selection: Optional[ModelSelection] = None,
    **extra: Any,
) -> Any:
    """Route, budget-check, call, and log a Chat Completions request."""

    router = OpenAIModelRouter()
    prompt_text = _messages_text(messages)
    selection = forced_model_selection or router.select_model(
        task,
        prompt_text,
        risk_level=risk_level,
        needs_live_data=needs_live_data,
        route=route,
    )
    explicit_model = extra.pop("model", None)
    if explicit_model:
        selection = ModelSelection(
            model=str(explicit_model),
            tier=selection.tier,
            reason=f"{selection.reason}:explicit_model_override",
            max_output_tokens=selection.max_output_tokens,
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
        actual_metadata = _usage_metadata(router, selection.model, response)
        metadata = {
            "model_used": selection.model,
            "model_tier": selection.tier,
            "reason": selection.reason,
            "estimated_input_tokens": input_tokens,
            "estimated_output_tokens": output_tokens,
            "estimated_cost_usd": estimated_cost,
            **actual_metadata,
        }
        record_openai_usage(
            usage_session,
            user_id=user_id,
            request_id=request_id,
            route=route,
            selection=selection,
            estimated_input_tokens=input_tokens,
            estimated_output_tokens=output_tokens,
            estimated_cost_usd=estimated_cost,
            actual_input_tokens=actual_metadata.get("actual_input_tokens"),
            actual_output_tokens=actual_metadata.get("actual_output_tokens"),
            actual_cost_usd=actual_metadata.get("actual_cost_usd"),
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
                "actual_input_tokens": actual_metadata.get("actual_input_tokens"),
                "actual_output_tokens": actual_metadata.get("actual_output_tokens"),
                "actual_cost_usd": round(float(actual_metadata.get("actual_cost_usd") or 0.0), 8)
                if actual_metadata.get("actual_cost_usd") is not None
                else None,
            },
        )
        return _attach_metadata(response, metadata)
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
    if request_id:
        cache_key = (
            str(request_id),
            embedding_model,
            hashlib.sha256(prompt_text.encode("utf-8")).hexdigest(),
        )
        cached = _EMBEDDING_TURN_CACHE.get(cache_key)
        if cached and (time.time() - cached[0]) <= 300:
            return cached[1]
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
        if request_id:
            _EMBEDDING_TURN_CACHE[cache_key] = (time.time(), response)
            if len(_EMBEDDING_TURN_CACHE) > 256:
                for old_key in list(_EMBEDDING_TURN_CACHE.keys())[:64]:
                    _EMBEDDING_TURN_CACHE.pop(old_key, None)
        actual_metadata = _usage_metadata(router, embedding_model, response)
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
            actual_input_tokens=actual_metadata.get("actual_input_tokens"),
            actual_output_tokens=actual_metadata.get("actual_output_tokens"),
            actual_cost_usd=actual_metadata.get("actual_cost_usd"),
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
                "actual_input_tokens": actual_metadata.get("actual_input_tokens"),
                "actual_output_tokens": actual_metadata.get("actual_output_tokens"),
                "actual_cost_usd": round(float(actual_metadata.get("actual_cost_usd") or 0.0), 8)
                if actual_metadata.get("actual_cost_usd") is not None
                else None,
            },
        )
        return response
    finally:
        if owned_session is not None:
            owned_session.close()


def embedding_vector(response: Any) -> list[float]:
    """Extract a validated vector from an OpenAI-compatible embedding response."""
    data = response.get("data") if isinstance(response, dict) else getattr(response, "data", None)
    if not data:
        return []
    first = data[0]
    value = first.get("embedding") if isinstance(first, dict) else getattr(first, "embedding", None)
    if not isinstance(value, list):
        return []
    result: list[float] = []
    for item in value:
        try:
            result.append(float(item))
        except (TypeError, ValueError):
            return []
    return result


def cached_text_embedding(
    text_value: str,
    *,
    session: Optional[Session] = None,
    user_id: Any = None,
    request_id: Optional[str] = None,
    route: str = "semantic_embedding",
    ttl_seconds: int = 86_400,
) -> list[float]:
    """Embed normalized text once and cache it in Valkey (or process memory) for 24h."""
    normalized = re.sub(r"\s+", " ", str(text_value or "")).strip().casefold()
    if not normalized:
        return []
    model = (
        str(os.getenv("RAG_EMBEDDING_MODEL") or os.getenv("OPENAI_EMBEDDING_MODEL") or "").strip()
        or "text-embedding-3-small"
    )
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    key = f"embedding:v1:{model}:{digest}"
    now = time.time()
    with _TEXT_EMBEDDING_CACHE_LOCK:
        cached = _TEXT_EMBEDDING_CACHE.get(key)
        if cached and cached[0] > now:
            return list(cached[1])

    redis_client = None
    redis_url = str(os.getenv("REDIS_URL") or "").strip()
    if redis_url:
        try:
            import redis  # type: ignore

            redis_client = redis.Redis.from_url(redis_url, decode_responses=True)
            raw = redis_client.get(key)
            if raw:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    vector = [float(value) for value in parsed]
                    with _TEXT_EMBEDDING_CACHE_LOCK:
                        _TEXT_EMBEDDING_CACHE[key] = (
                            now + max(1, int(ttl_seconds)),
                            vector,
                        )
                    return vector
        except Exception:
            redis_client = None

    api_key = str(os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return []
    try:
        from openai import OpenAI  # type: ignore

        response = tracked_embedding(
            OpenAI(api_key=api_key),
            input=[normalized],
            session=session,
            route=route,
            user_id=user_id,
            request_id=request_id or f"embedding:{digest}",
            model=model,
        )
        vector = embedding_vector(response)
    except Exception:
        logger.exception("cached text embedding failed", extra={"route": route})
        return []
    if not vector:
        return []
    ttl = max(1, int(ttl_seconds))
    with _TEXT_EMBEDDING_CACHE_LOCK:
        _TEXT_EMBEDDING_CACHE[key] = (now + ttl, list(vector))
        if len(_TEXT_EMBEDDING_CACHE) > 2048:
            expired_or_old = sorted(
                _TEXT_EMBEDDING_CACHE,
                key=lambda item: _TEXT_EMBEDDING_CACHE[item][0],
            )[:256]
            for old_key in expired_or_old:
                _TEXT_EMBEDDING_CACHE.pop(old_key, None)
    if redis_client is not None:
        try:
            redis_client.setex(key, ttl, json.dumps(vector, separators=(",", ":")))
        except Exception:
            pass
    return vector
