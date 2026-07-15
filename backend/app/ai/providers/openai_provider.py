from __future__ import annotations

import os
from typing import Any, Callable, Optional

from fastapi import HTTPException

from ...openai_model_router import OpenAIModelRouter
from ...openai_tracked import get_tracked_chat_completion_metadata, tracked_openai_generation
from ..prompts import build_provider_messages, build_system_instructions
from ..types import AIProviderResponse, AIRequest, AIRoute
from .base import AIProvider, GenerationCancellation, GenerationCancelled


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
        instructions = build_system_instructions(request, route, provider="openai")
        messages = build_provider_messages(request, route, provider="openai")
        response = tracked_openai_generation(
            self._client_or_create(),
            task=task,
            route=route.route,
            session=request.metadata.get("session"),
            user_id=request.user_id,
            request_id=request.request_id,
            candidates=candidates,
            input_text=request.message,
            instructions=instructions,
            messages=messages,
            temperature=0.2,
            max_output_tokens=route.max_output_tokens,
        )
        text = _extract_response_text(response)
        metadata = get_tracked_chat_completion_metadata(response)
        input_tokens = int(metadata.get("actual_input_tokens") or metadata.get("estimated_input_tokens") or router.estimate_tokens(request.message))
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
            "primary_model_candidate": metadata.get("primary_model_candidate")
            or route.metadata.get("primary_model_candidate")
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
            "actual_cost_usd": metadata.get("actual_cost_usd"),
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
        """Stream upstream OpenAI deltas and retain final provider usage for billing."""
        client = self._client_or_create()
        model = (route.model_candidates or [route.model])[0] or route.model or "gpt-4o-mini"
        messages = build_provider_messages(request, route, provider="openai")
        text_parts: list[str] = []
        input_tokens = output_tokens = cached_tokens = 0
        provider_usage_received = False
        endpoint = str((route.provider_endpoint_candidates or [""])[0] or "chat_completions")
        cancellation = request.metadata.get("cancellation_signal")
        if not isinstance(cancellation, GenerationCancellation):
            cancellation = None

        def partial_response() -> AIProviderResponse | None:
            text = "".join(text_parts).strip()
            if not text and not provider_usage_received:
                return None
            router = OpenAIModelRouter()
            billed_input = input_tokens or router.estimate_tokens(request.message)
            billed_output = output_tokens or router.estimate_tokens(text)
            return AIProviderResponse(
                text=text, provider="openai", model=model, route=route.route, reason=route.reason,
                language=route.language, intent=route.intent, input_tokens=billed_input,
                output_tokens=billed_output, characters=len(text),
                estimated_cost_amount=router.estimate_cost(model, billed_input, billed_output),
                estimated_cost_currency="USD",
                raw={"usage_actual": provider_usage_received, "cached_input_tokens": cached_tokens, "endpoint": endpoint, "cancelled": True},
            )

        def check_cancelled() -> None:
            if cancellation and cancellation.cancelled:
                raise GenerationCancelled(partial_response())

        check_cancelled()
        if endpoint == "responses" and hasattr(client, "responses"):
            stream = client.responses.create(
                model=model, input=messages, max_output_tokens=route.max_output_tokens, stream=True
            )
            if cancellation:
                cancellation.bind_stream(stream)
            for event in stream:
                check_cancelled()
                event_type = str(getattr(event, "type", "") or "")
                if event_type in {"response.output_text.delta", "response.refusal.delta"}:
                    delta = str(getattr(event, "delta", "") or "")
                    if delta:
                        text_parts.append(delta); on_delta(delta)
                response = getattr(event, "response", None)
                usage = getattr(response, "usage", None)
                if usage is not None:
                    provider_usage_received = True
                    input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
                    output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
                    details = getattr(usage, "input_tokens_details", None)
                    cached_tokens = int(getattr(details, "cached_tokens", 0) or 0)
        else:
            stream = client.chat.completions.create(
                model=model, messages=messages, max_tokens=route.max_output_tokens,
                temperature=0.2, stream=True, stream_options={"include_usage": True},
            )
            if cancellation:
                cancellation.bind_stream(stream)
            for chunk in stream:
                check_cancelled()
                choices = getattr(chunk, "choices", None) or []
                if choices:
                    delta = str(getattr(getattr(choices[0], "delta", None), "content", "") or "")
                    if delta:
                        text_parts.append(delta); on_delta(delta)
                usage = getattr(chunk, "usage", None)
                if usage is not None:
                    provider_usage_received = True
                    input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
                    output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
                    details = getattr(usage, "prompt_tokens_details", None)
                    cached_tokens = int(getattr(details, "cached_tokens", 0) or 0)
        text = "".join(text_parts).strip()
        if not text:
            raise HTTPException(status_code=502, detail="OpenAI returned an empty streamed response.")
        router = OpenAIModelRouter()
        input_tokens = input_tokens or router.estimate_tokens(request.message)
        output_tokens = output_tokens or router.estimate_tokens(text)
        return AIProviderResponse(
            text=text, provider="openai", model=model, route=route.route, reason=route.reason,
            language=route.language, intent=route.intent, input_tokens=input_tokens,
            output_tokens=output_tokens, characters=len(text),
            estimated_cost_amount=router.estimate_cost(model, input_tokens, output_tokens),
            estimated_cost_currency="USD",
            raw={"usage_actual": provider_usage_received, "cached_input_tokens": cached_tokens, "endpoint": endpoint},
        )


def _extract_response_text(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
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
