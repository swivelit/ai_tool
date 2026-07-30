from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Callable, Optional

from fastapi import HTTPException

from ...database import SessionLocal
from ...openai_model_router import OpenAIModelRouter, record_openai_usage
from ...openai_tracked import (
    enforce_openai_budget, get_tracked_chat_completion_metadata,
    tracked_openai_generation,
)
from ..model_health import is_model_temporarily_unavailable, mark_model_unavailable
from ..openai_catalog import get_model_spec
from ..openai_reasoning import (
    OpenAIReasoningEffortConfigurationError, openai_web_reasoning_effort,
)
from ..prompts import (
    build_provider_messages, serialize_provider_messages, stable_prompt_cache_key,
)
from ..types import AIProviderResponse, AIRequest, AIRoute
from .base import (
    AIProvider, GenerationCancellation, GenerationCancelled, GenerationIncomplete,
)


logger = logging.getLogger(__name__)


class OpenAIProvider(AIProvider):
    def __init__(self, client: Optional[Any] = None) -> None:
        self._client = client

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if not api_key:
            raise HTTPException(
                status_code=503,
                detail="OpenAI provider/configuration error. Check OPENAI_API_KEY and OPENAI_MODEL settings.",
            )
        import openai

        self._client = openai.OpenAI(api_key=api_key)
        return self._client

    def complete(self, request: AIRequest, route: AIRoute) -> AIProviderResponse:
        task = "coding" if route.intent in {"coding", "complex_reasoning"} else "normal_qa"
        router = OpenAIModelRouter()
        selected_candidates = route.model_candidates or [selection.model for selection in router.select_candidates(task, request.message, route=route)]
        candidates: list[Any] = []
        for index, model in enumerate(selected_candidates):
            candidate: dict[str, Any] = {"model": model}
            if index < len(route.provider_endpoint_candidates):
                candidate["endpoint"] = route.provider_endpoint_candidates[index]
            candidates.append(candidate)
        messages = build_provider_messages(request, route, provider="openai")
        answer_class = (
            request.metadata.get("answer_class")
            or route.metadata.get("answer_class")
        )
        response = tracked_openai_generation(
            self._client_or_create(),
            task=task,
            route=route.route,
            session=request.metadata.get("session"),
            user_id=request.user_id,
            request_id=request.request_id,
            candidates=candidates,
            input_text=None,
            instructions=None,
            messages=messages,
            temperature=0.2,
            max_output_tokens=route.max_output_tokens,
            max_provider_attempts=min(2, int(request.metadata.get("max_provider_attempts") or 2)),
            estimated_input_tokens=int(request.metadata.get("estimated_prompt_tokens") or 0) or None,
            prompt_cache_key=stable_prompt_cache_key(request, route),
            answer_class=answer_class,
        )
        text = _extract_response_text(response)
        metadata = get_tracked_chat_completion_metadata(response)
        completion_metadata = _completion_metadata(response)
        usage = _value(response, "usage", None)
        provider_usage_received = usage is not None
        reasoning_tokens = int(metadata.get("reasoning_tokens") or 0)
        if (
            not text
            and completion_metadata["completion_status"] == "incomplete"
            and completion_metadata["incomplete_reason"] == "max_output_tokens"
        ):
            diagnostics = _terminal_diagnostics(
                request=request,
                model=str(metadata.get("model_used") or route.model or ""),
                endpoint=str(metadata.get("endpoint") or "responses"),
                answer_class=answer_class,
                reasoning_effort=metadata.get("reasoning_effort"),
                max_output_tokens=int(
                    metadata.get("estimated_output_tokens")
                    or route.max_output_tokens
                ),
                terminal_event_type="non_streaming_response",
                completion_metadata=completion_metadata,
                input_tokens=int(metadata.get("actual_input_tokens") or 0),
                output_tokens=int(metadata.get("actual_output_tokens") or 0),
                reasoning_tokens=reasoning_tokens,
                visible_characters=0,
                provider_usage_received=provider_usage_received,
            )
            logger.warning(
                "openai_generation_no_visible_output",
                extra={"event": "openai_generation_no_visible_output", **diagnostics},
            )
            raise GenerationIncomplete(
                completion_status=str(completion_metadata["completion_status"]),
                incomplete_reason=str(completion_metadata["incomplete_reason"]),
                finish_reason=str(completion_metadata["finish_reason"]),
                input_tokens=int(metadata.get("actual_input_tokens") or 0),
                output_tokens=int(metadata.get("actual_output_tokens") or 0),
                reasoning_tokens=reasoning_tokens,
                visible_characters=0,
                max_output_tokens=int(
                    metadata.get("estimated_output_tokens")
                    or route.max_output_tokens
                ),
                provider_usage_received=provider_usage_received,
            )
        canonical_prompt = str(request.metadata.get("serialized_provider_prompt") or serialize_provider_messages(messages))
        input_tokens = int(metadata.get("actual_input_tokens") or metadata.get("estimated_input_tokens") or router.estimate_tokens(canonical_prompt))
        output_tokens = int(metadata.get("actual_output_tokens") or metadata.get("estimated_output_tokens") or router.estimate_tokens(text))
        estimated_cost = float(metadata.get("actual_cost_usd") if metadata.get("actual_cost_usd") is not None else metadata.get("estimated_cost_usd") or router.estimate_cost(route.model or "", input_tokens, output_tokens))
        raw = {
            "reply_language": request.reply_language or route.language,
            "input_language": route.metadata.get("input_language") or request.metadata.get("input_language") or "",
            "profile_context_included": bool(request.metadata.get("profile_prompt_context")),
            "original_message": route.metadata.get("original_message") or request.message,
            "normalized_message": route.metadata.get("normalized_message") or request.message,
            "stripped_wake_word": bool(route.metadata.get("stripped_wake_word")),
            "stripped_prefix": route.metadata.get("stripped_prefix") or "",
            "intent_before_cleanup": route.metadata.get("intent_before_cleanup") or route.intent,
            "intent_after_cleanup": route.metadata.get("intent_after_cleanup") or route.intent,
            "model_tier": metadata.get("model_tier"),
            "endpoint": metadata.get("endpoint"),
            "model_candidates": metadata.get("model_candidates") or candidates,
            "openai_attempted_models": metadata.get("attempted_models") or [],
            "fallback_attempted": bool(metadata.get("fallback_attempted")),
            "candidate_index": metadata.get("candidate_index"),
            "primary_model_candidate": route.metadata.get("primary_model_candidate")
            or metadata.get("primary_model_candidate")
            or (route.model_candidates[0] if route.model_candidates else route.model),
            "selected_model_reason": metadata.get("selected_model_reason")
            or route.metadata.get("selected_model_reason")
            or metadata.get("reason")
            or route.reason,
            "skipped_models": metadata.get("skipped_models") or route.metadata.get("skipped_models") or [],
            "model_health_skip_reason": metadata.get("model_health_skip_reason")
            or route.metadata.get("model_health_skip_reason")
            or "",
            "usage_actual": metadata.get("actual_input_tokens") is not None
            or metadata.get("actual_output_tokens") is not None,
            "cached_input_tokens": int(metadata.get("cached_input_tokens") or 0),
            "cache_write_tokens": int(metadata.get("cache_write_tokens") or 0),
            "provider_attempts": int(metadata.get("provider_attempts") or len(metadata.get("attempted_models") or []) or 1),
            "provider_calls_with_usage": int(metadata.get("provider_calls_with_usage") or (1 if metadata.get("actual_input_tokens") is not None or metadata.get("actual_output_tokens") is not None else 0)),
            "actual_cost_usd": metadata.get("actual_cost_usd"),
            "reasoning_tokens": reasoning_tokens,
            "reasoning_effort": metadata.get("reasoning_effort"),
            **completion_metadata,
        }
        return AIProviderResponse(
            text=text or "I could not produce an answer. Please try again.",
            provider="openai",
            model=metadata.get("model_used") or route.model,
            route=route.route,
            reason=metadata.get("reason") or route.reason,
            language=route.language,
            intent=route.intent,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            characters=len(text or ""),
            estimated_cost_amount=estimated_cost,
            estimated_cost_currency="USD",
            raw=raw,
        )

    def stream_complete(
        self, request: AIRequest, route: AIRoute, on_delta: Callable[[str], None]
    ) -> AIProviderResponse:
        """Stream normally, buffering only the enabled degradation ladder.

        Buffering is required only when an attempt may be discarded before the
        single permitted escalation. Non-ladder requests continue to emit every
        provider delta immediately.
        """
        client = self._client_or_create()
        messages = build_provider_messages(request, route, provider="openai")
        canonical_prompt = str(request.metadata.get("serialized_provider_prompt") or serialize_provider_messages(messages))
        candidates = [item for item in (route.model_candidates or [route.model]) if item]
        endpoints = route.provider_endpoint_candidates or []
        cancellation = request.metadata.get("cancellation_signal")
        if not isinstance(cancellation, GenerationCancellation):
            cancellation = None
        last_error: Exception | None = None
        provider_attempts = 0
        accumulated_input_tokens = 0
        accumulated_output_tokens = 0
        accumulated_cached_tokens = 0
        accumulated_cache_write_tokens = 0
        accumulated_cost = 0.0
        accumulated_usage_calls = 0
        accumulated_usage_actual = False
        confidence_ladder = os.getenv(
            "WEB_MODEL_LADDER_DOWNGRADE_ENABLED", "false"
        ).strip().lower() in {"1", "true", "yes", "on"}
        max_attempts = min(2, max(1, int(request.metadata.get("max_provider_attempts") or 2)))
        for index, model in enumerate(candidates):
            endpoint = str(
                (endpoints[index] if index < len(endpoints) else "")
                or "responses"
            )
            if is_model_temporarily_unavailable("openai", model, endpoint):
                continue
            if provider_attempts >= max_attempts:
                break
            provider_attempts += 1
            text_parts: list[str] = []
            input_tokens = output_tokens = cached_tokens = cache_write_tokens = 0
            reasoning_tokens = 0
            provider_usage_received = False
            finish_reason = "unknown"
            completion_status = "unknown"
            incomplete_reason = ""
            terminal_event_type = ""
            final_response: Any | None = None
            provider_refusal = False
            budget_router = OpenAIModelRouter()
            budget_input = int(request.metadata.get("estimated_prompt_tokens") or budget_router.estimate_tokens(canonical_prompt))
            budget_output = min(route.max_output_tokens, budget_router.max_output_hard)
            estimated_budget_cost = budget_router.estimate_cost(
                model, budget_input, budget_output
            )
            enforce_openai_budget(
                request.metadata.get("session"), route=route.route, model=model,
                model_tier=str(route.metadata.get("model_tier") or "web"),
                estimated_cost_usd=estimated_budget_cost,
            )

            def partial_response() -> AIProviderResponse | None:
                text = "".join(text_parts).strip()
                if not text and not provider_usage_received:
                    return None
                router = OpenAIModelRouter()
                billed_input = input_tokens or int(request.metadata.get("estimated_prompt_tokens") or router.estimate_tokens(canonical_prompt))
                billed_output = output_tokens or router.estimate_tokens(text)
                return AIProviderResponse(
                    text=text, provider="openai", model=model, route=route.route,
                    reason=route.reason, language=route.language, intent=route.intent,
                    input_tokens=billed_input, output_tokens=billed_output,
                    characters=len(text),
                    estimated_cost_amount=router.estimate_cost(model, billed_input, billed_output),
                    estimated_cost_currency="USD",
                    raw={
                        "usage_actual": provider_usage_received,
                        "cached_input_tokens": cached_tokens,
                        "cache_write_tokens": cache_write_tokens,
                        "endpoint": endpoint,
                        "cancelled": True,
                        "provider_attempts": provider_attempts,
                        "provider_calls_with_usage": 1 if provider_usage_received else 0,
                        "finish_reason": "cancelled",
                        "truncated": False,
                        "completion_status": "cancelled",
                    },
                )

            def check_cancelled() -> None:
                if cancellation and cancellation.cancelled:
                    raise GenerationCancelled(partial_response())

            try:
                check_cancelled()
                if endpoint == "responses":
                    if not hasattr(client, "responses"):
                        raise RuntimeError("Responses API is unavailable in the configured client")
                    answer_class = (
                        request.metadata.get("answer_class")
                        or route.metadata.get("answer_class")
                    )
                    model_spec = get_model_spec(model)
                    reasoning_effort = (
                        openai_web_reasoning_effort(answer_class)
                        if model_spec.supports_reasoning_effort
                        else None
                    )
                    response_kwargs: dict[str, Any] = {
                        "model": model,
                        "input": messages,
                        "max_output_tokens": route.max_output_tokens,
                        "stream": True,
                    }
                    if reasoning_effort is not None:
                        response_kwargs["reasoning"] = {
                            "effort": reasoning_effort
                        }
                    prompt_cache_key = stable_prompt_cache_key(request, route)
                    if prompt_cache_key:
                        response_kwargs["prompt_cache_key"] = prompt_cache_key
                    stream = client.responses.create(
                        **response_kwargs,
                    )
                    if cancellation:
                        cancellation.bind_stream(stream)
                    for event in stream:
                        check_cancelled()
                        event_type = str(getattr(event, "type", "") or "")
                        if event_type in {"response.output_text.delta", "response.refusal.delta"}:
                            if event_type == "response.refusal.delta":
                                provider_refusal = True
                            delta = str(getattr(event, "delta", "") or "")
                            if delta:
                                text_parts.append(delta)
                                if not confidence_ladder:
                                    on_delta(delta)
                        response = getattr(event, "response", None)
                        if event_type == "response.created" and response is not None:
                            completion_status = str(getattr(response, "status", "") or "in_progress")
                        if event_type in {"response.completed", "response.incomplete", "response.failed"}:
                            final_response = response
                            terminal_event_type = event_type
                            final_metadata = _completion_metadata(response)
                            finish_reason = str(final_metadata["finish_reason"])
                            completion_status = str(final_metadata["completion_status"])
                            incomplete_reason = str(final_metadata.get("incomplete_reason") or "")
                            if completion_status == "unknown":
                                completion_status = {
                                    "response.completed": "complete",
                                    "response.incomplete": "incomplete",
                                    "response.failed": "failed",
                                }[event_type]
                        usage = _value(response, "usage", None)
                        if usage is not None:
                            provider_usage_received = True
                            input_tokens = int(
                                _value(usage, "input_tokens", 0) or 0
                            )
                            output_tokens = int(
                                _value(usage, "output_tokens", 0) or 0
                            )
                            details = _value(
                                usage, "input_tokens_details", None
                            )
                            cached_tokens = int(
                                _value(details, "cached_tokens", 0) or 0
                            )
                            cache_write_tokens = int(
                                _value(details, "cache_write_tokens", 0)
                                or _value(
                                    details,
                                    "cache_creation_input_tokens",
                                    0,
                                )
                                or 0
                            )
                            output_details = _value(
                                usage, "output_tokens_details", None
                            )
                            reasoning_tokens = int(
                                _value(
                                    output_details, "reasoning_tokens", 0
                                )
                                or 0
                            )
                else:
                    answer_class = (
                        request.metadata.get("answer_class")
                        or route.metadata.get("answer_class")
                    )
                    reasoning_effort = None
                    chat_kwargs: dict[str, Any] = {
                        "model": model,
                        "messages": messages,
                        "max_tokens": route.max_output_tokens,
                        "temperature": 0.2,
                        "stream": True,
                        "stream_options": {"include_usage": True},
                    }
                    prompt_cache_key = stable_prompt_cache_key(request, route)
                    if prompt_cache_key:
                        chat_kwargs["prompt_cache_key"] = prompt_cache_key
                    stream = client.chat.completions.create(**chat_kwargs)
                    if cancellation:
                        cancellation.bind_stream(stream)
                    for chunk in stream:
                        check_cancelled()
                        choices = getattr(chunk, "choices", None) or []
                        if choices:
                            observed_finish = getattr(choices[0], "finish_reason", None)
                            if observed_finish:
                                finish_reason = _normalize_finish_reason(observed_finish)
                                completion_status = "incomplete" if finish_reason == "length" else "complete"
                            delta = str(
                                getattr(getattr(choices[0], "delta", None), "content", "") or ""
                            )
                            if delta:
                                text_parts.append(delta)
                                if not confidence_ladder:
                                    on_delta(delta)
                        usage = getattr(chunk, "usage", None)
                        if usage is not None:
                            provider_usage_received = True
                            input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
                            output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
                            details = getattr(usage, "prompt_tokens_details", None)
                            cached_tokens = int(getattr(details, "cached_tokens", 0) or 0)
                            cache_write_tokens = int(
                                getattr(details, "cache_write_tokens", 0)
                                or getattr(details, "cache_creation_input_tokens", 0) or 0
                            )
                if not text_parts and final_response is not None:
                    recovered_text = _extract_response_text(final_response)
                    if recovered_text:
                        text_parts.append(recovered_text)
                        if not confidence_ladder:
                            on_delta(recovered_text)
                text = "".join(text_parts).strip()
                terminal_completion_metadata = {
                    "finish_reason": finish_reason,
                    "truncated": finish_reason == "length",
                    "completion_status": completion_status,
                    "incomplete_reason": incomplete_reason,
                }
                reported_input_tokens = input_tokens
                reported_output_tokens = output_tokens
                if endpoint == "responses" and terminal_event_type:
                    logger.info(
                        "openai_stream_terminal",
                        extra={
                            "event": "openai_stream_terminal",
                            **_terminal_diagnostics(
                                request=request,
                                model=model,
                                endpoint=endpoint,
                                answer_class=answer_class,
                                reasoning_effort=reasoning_effort,
                                max_output_tokens=route.max_output_tokens,
                                terminal_event_type=terminal_event_type,
                                completion_metadata=terminal_completion_metadata,
                                input_tokens=reported_input_tokens,
                                output_tokens=reported_output_tokens,
                                reasoning_tokens=reasoning_tokens,
                                visible_characters=len(text),
                                provider_usage_received=provider_usage_received,
                            ),
                        },
                    )
                router = OpenAIModelRouter()
                input_tokens = input_tokens or int(request.metadata.get("estimated_prompt_tokens") or router.estimate_tokens(canonical_prompt))
                output_tokens = output_tokens or router.estimate_tokens(text)
                actual_cost = router.estimate_cost(
                    model, input_tokens, output_tokens,
                    cached_tokens, cache_write_tokens,
                )
                usage_session = request.metadata.get("session")
                record_kwargs = {
                    "user_id": request.user_id,
                    "request_id": request.request_id,
                    "route": route.route,
                    "model_used": model,
                    "model_tier": str(route.metadata.get("model_tier") or "web"),
                    "reason": route.reason,
                    "estimated_input_tokens": budget_input,
                    "estimated_output_tokens": budget_output,
                    "estimated_cost_usd": estimated_budget_cost,
                    "actual_input_tokens": input_tokens if provider_usage_received else None,
                    "actual_output_tokens": output_tokens if provider_usage_received else None,
                    "actual_cost_usd": actual_cost if provider_usage_received else None,
                }
                if usage_session is not None:
                    record_openai_usage(usage_session, **record_kwargs)
                else:
                    with SessionLocal() as created_usage_session:
                        record_openai_usage(created_usage_session, **record_kwargs)
                if (
                    not text
                    and completion_status == "incomplete"
                    and incomplete_reason == "max_output_tokens"
                ):
                    diagnostics = _terminal_diagnostics(
                        request=request,
                        model=model,
                        endpoint=endpoint,
                        answer_class=answer_class,
                        reasoning_effort=reasoning_effort,
                        max_output_tokens=route.max_output_tokens,
                        terminal_event_type=terminal_event_type,
                        completion_metadata=terminal_completion_metadata,
                        input_tokens=reported_input_tokens,
                        output_tokens=reported_output_tokens,
                        reasoning_tokens=reasoning_tokens,
                        visible_characters=0,
                        provider_usage_received=provider_usage_received,
                    )
                    logger.warning(
                        "openai_generation_no_visible_output",
                        extra={
                            "event": "openai_generation_no_visible_output",
                            **diagnostics,
                        },
                    )
                    raise GenerationIncomplete(
                        completion_status=completion_status,
                        incomplete_reason=incomplete_reason,
                        finish_reason=finish_reason,
                        input_tokens=reported_input_tokens,
                        output_tokens=reported_output_tokens,
                        reasoning_tokens=reasoning_tokens,
                        visible_characters=0,
                        max_output_tokens=route.max_output_tokens,
                        provider_usage_received=provider_usage_received,
                    )
                degradation_reason = _local_degradation_reason(
                    text,
                    answer_class=str(
                        request.metadata.get("answer_class")
                        or route.metadata.get("answer_class")
                        or "normal"
                    ),
                    finish_reason=finish_reason,
                    completion_status=completion_status,
                    provider_refusal=provider_refusal,
                    request_message=request.message,
                )
                degraded = bool(degradation_reason)
                if (
                    confidence_ladder
                    and degraded
                    and provider_attempts < max_attempts
                    and index + 1 < len(candidates)
                    and not provider_usage_received
                ):
                    accumulated_input_tokens += input_tokens
                    accumulated_output_tokens += output_tokens
                    accumulated_cached_tokens += cached_tokens
                    accumulated_cache_write_tokens += cache_write_tokens
                    accumulated_cost += actual_cost
                    accumulated_usage_calls += 1 if provider_usage_received else 0
                    accumulated_usage_actual = (
                        accumulated_usage_actual or provider_usage_received
                    )
                    continue
                if not text:
                    logger.warning(
                        "openai_generation_no_visible_output",
                        extra={
                            "event": "openai_generation_no_visible_output",
                            **_terminal_diagnostics(
                                request=request,
                                model=model,
                                endpoint=endpoint,
                                answer_class=answer_class,
                                reasoning_effort=reasoning_effort,
                                max_output_tokens=route.max_output_tokens,
                                terminal_event_type=terminal_event_type,
                                completion_metadata=terminal_completion_metadata,
                                input_tokens=reported_input_tokens,
                                output_tokens=reported_output_tokens,
                                reasoning_tokens=reasoning_tokens,
                                visible_characters=0,
                                provider_usage_received=provider_usage_received,
                            ),
                        },
                    )
                    raise RuntimeError("Empty streamed response")
                if confidence_ladder:
                    on_delta(text)
                return AIProviderResponse(
                    text=text, provider="openai", model=model, route=route.route,
                    reason=route.reason, language=route.language, intent=route.intent,
                    input_tokens=input_tokens + accumulated_input_tokens,
                    output_tokens=output_tokens + accumulated_output_tokens,
                    characters=len(text),
                    estimated_cost_amount=actual_cost + accumulated_cost,
                    estimated_cost_currency="USD",
                    raw={
                        "usage_actual": (
                            accumulated_usage_actual or provider_usage_received
                        ),
                        "cached_input_tokens": (
                            cached_tokens + accumulated_cached_tokens
                        ),
                        "cache_write_tokens": (
                            cache_write_tokens + accumulated_cache_write_tokens
                        ),
                        "endpoint": endpoint,
                        "fallback_attempted": provider_attempts > 1,
                        "provider_attempts": provider_attempts,
                        "provider_calls_with_usage": accumulated_usage_calls + (1 if provider_usage_received else 0),
                        "primary_model_candidate": route.metadata.get("primary_model_candidate") or (candidates[0] if candidates else model),
                        "selected_model_reason": (
                            "local_degradation_escalation"
                            if accumulated_input_tokens > 0
                            else "zero_output_zero_usage_failover"
                            if provider_attempts > 1
                            else route.metadata.get("selected_model_reason") or "configured_primary"
                        ),
                        "finish_reason": finish_reason,
                        "truncated": finish_reason == "length",
                        "completion_status": completion_status,
                        "incomplete_reason": incomplete_reason,
                        "reasoning_tokens": reasoning_tokens,
                        "reasoning_effort": reasoning_effort,
                        "degradation_reason": degradation_reason,
                        "tier_escalated": accumulated_input_tokens > 0,
                        "actual_cost_usd": (
                            actual_cost + accumulated_cost
                            if accumulated_usage_actual or provider_usage_received
                            else None
                        ),
                    },
                )
            except GenerationCancelled:
                raise
            except GenerationIncomplete:
                raise
            except OpenAIReasoningEffortConfigurationError:
                raise
            except Exception as exc:
                last_error = exc
                if text_parts or provider_usage_received or _exception_reported_output_or_usage(exc):
                    raise
                mark_model_unavailable(
                    "openai", model, endpoint, exc.__class__.__name__, ttl_seconds=60
                )
                continue
        raise HTTPException(
            status_code=503,
            detail="The selected Swico mode is temporarily unavailable.",
        ) from None


def _local_degradation_reason(
    text: str,
    *,
    answer_class: str,
    finish_reason: str,
    completion_status: str,
    provider_refusal: bool,
    request_message: str,
) -> str:
    """Classify a completed attempt without relying on provider confidence."""
    value = str(text or "").strip()
    normalized_finish = _normalize_finish_reason(finish_reason)
    normalized_status = str(completion_status or "").strip().lower()
    if normalized_finish == "length":
        return "finish_reason_length"
    if provider_refusal or normalized_finish == "content_filter":
        return "provider_refusal"
    if normalized_status in {"failed", "incomplete"}:
        return "provider_incomplete"
    if not value:
        return "empty_output"

    structured_requested = bool(
        re.search(
            r"\b(?:json|structured response|valid object|machine[- ]readable)\b",
            str(request_message or ""),
            re.IGNORECASE,
        )
    )
    structured_value = value
    fenced = re.search(
        r"```(?:json)?\s*(.*?)```", value, re.IGNORECASE | re.DOTALL
    )
    if fenced:
        structured_value = fenced.group(1).strip()
    if structured_requested or structured_value.startswith(("{", "[")):
        try:
            json.loads(structured_value)
        except (TypeError, ValueError):
            return "incomplete_structured_response"

    answer = str(answer_class or "normal").strip().lower()
    if answer in {"detailed", "long_form"}:
        default_minimum = 45 if answer == "detailed" else 90
        try:
            minimum = max(
                1,
                int(os.getenv(
                    "WEB_DETAILED_MIN_OUTPUT_WORDS"
                    if answer == "detailed"
                    else "WEB_LONG_FORM_MIN_OUTPUT_WORDS",
                    str(default_minimum),
                )),
            )
        except (TypeError, ValueError):
            minimum = default_minimum
        if len(re.findall(r"\S+", value)) < minimum:
            return f"implausibly_short_{answer}"
    return ""


def _extract_response_text(response: Any) -> str:
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
    if parts:
        return "\n".join(part.strip() for part in parts if part.strip()).strip()
    try:
        if hasattr(response, "choices") and response.choices:
            return str(response.choices[0].message.content or "").strip()
    except Exception:
        return ""
    return ""


def _value(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _normalize_finish_reason(value: Any) -> str:
    reason = str(value or "").strip().lower()
    if reason in {"length", "max_output_tokens", "max_tokens"}:
        return "length"
    if reason in {"stop", "completed", "complete", "end_turn"}:
        return "stop"
    if reason in {"content_filter", "safety"}:
        return "content_filter"
    if reason in {"cancelled", "canceled"}:
        return "cancelled"
    if reason in {"tool_calls", "function_call"}:
        return reason
    return reason or "unknown"


def _completion_metadata(response: Any) -> dict[str, Any]:
    status = str(_value(response, "status", "") or "").strip().lower()
    incomplete = _value(response, "incomplete_details", None)
    incomplete_reason = str(_value(incomplete, "reason", "") or "").strip().lower()
    finish_reason = "unknown"
    choices = _value(response, "choices", None) or []
    if choices:
        finish_reason = _normalize_finish_reason(_value(choices[0], "finish_reason", None))
    elif incomplete_reason:
        finish_reason = _normalize_finish_reason(incomplete_reason)
    elif status in {"completed", "complete"}:
        finish_reason = "stop"
    completion_status = (
        "incomplete" if status == "incomplete" or finish_reason == "length"
        else "complete" if status in {"completed", "complete"} or finish_reason == "stop"
        else status or "unknown"
    )
    return {
        "finish_reason": finish_reason,
        "truncated": finish_reason == "length",
        "completion_status": completion_status,
        "incomplete_reason": incomplete_reason,
    }


def _terminal_diagnostics(
    *,
    request: AIRequest,
    model: str,
    endpoint: str,
    answer_class: Any,
    reasoning_effort: Any,
    max_output_tokens: int,
    terminal_event_type: str,
    completion_metadata: dict[str, Any],
    input_tokens: int,
    output_tokens: int,
    reasoning_tokens: int,
    visible_characters: int,
    provider_usage_received: bool,
) -> dict[str, Any]:
    """Build the allowlisted, content-free provider diagnostic payload."""

    return {
        "request_id": request.request_id,
        "internal_model": str(model or ""),
        "endpoint": str(endpoint or ""),
        "answer_class": str(answer_class or ""),
        "reasoning_effort": (
            str(reasoning_effort) if reasoning_effort is not None else None
        ),
        "max_output_tokens": max(0, int(max_output_tokens or 0)),
        "terminal_event_type": str(terminal_event_type or ""),
        "completion_status": str(
            completion_metadata.get("completion_status") or "unknown"
        ),
        "incomplete_reason": str(
            completion_metadata.get("incomplete_reason") or ""
        ),
        "finish_reason": str(
            completion_metadata.get("finish_reason") or "unknown"
        ),
        "input_tokens": max(0, int(input_tokens or 0)),
        "output_tokens": max(0, int(output_tokens or 0)),
        "reasoning_tokens": max(0, int(reasoning_tokens or 0)),
        "visible_output_characters": max(0, int(visible_characters or 0)),
        "provider_usage_received": bool(provider_usage_received),
    }


def _exception_reported_output_or_usage(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if response is None:
        return False
    if _extract_response_text(response):
        return True
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    return usage is not None
