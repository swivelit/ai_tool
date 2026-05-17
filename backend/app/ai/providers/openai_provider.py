from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import HTTPException

from ...openai_model_router import OpenAIModelRouter
from ...openai_tracked import get_tracked_chat_completion_metadata, tracked_chat_completion
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
        response = tracked_chat_completion(
            self._client_or_create(),
            task=task,
            route=route.route,
            session=request.metadata.get("session"),
            user_id=request.user_id,
            request_id=request.request_id,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a concise backend-controlled assistant. Answer directly. "
                        "Do not claim access to live/current data unless it was provided."
                    ),
                },
                {"role": "user", "content": request.message},
            ],
            temperature=0.2,
            max_tokens=route.max_output_tokens,
        )
        text = _extract_response_text(response)
        metadata = get_tracked_chat_completion_metadata(response)
        router = OpenAIModelRouter()
        input_tokens = int(metadata.get("actual_input_tokens") or metadata.get("estimated_input_tokens") or router.estimate_tokens(request.message))
        output_tokens = int(metadata.get("actual_output_tokens") or metadata.get("estimated_output_tokens") or router.estimate_tokens(text))
        estimated_cost = float(metadata.get("actual_cost_usd") if metadata.get("actual_cost_usd") is not None else metadata.get("estimated_cost_usd") or router.estimate_cost(route.model or "", input_tokens, output_tokens))
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
            raw={"model_tier": metadata.get("model_tier")},
        )


def _extract_response_text(response: Any) -> str:
    try:
        if hasattr(response, "choices") and response.choices:
            return str(response.choices[0].message.content or "").strip()
    except Exception:
        return ""
    return ""
