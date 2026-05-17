from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import HTTPException

from ...openai_model_router import OpenAIModelRouter
from ...openai_tracked import get_tracked_chat_completion_metadata, tracked_openai_generation
from ..prompts import build_provider_messages, build_system_instructions
from ..types import AIProviderResponse, AIRequest, AIRoute
from .base import AIProvider


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
