from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterator
from typing import Any

import httpx

from ..prompts import build_provider_messages, serialize_provider_messages
from ..types import AIProviderResponse, AIRequest, AIRoute
from .base import AIProvider, GenerationCancellation, GenerationCancelled


class SwicoFreeProviderError(RuntimeError):
    def __init__(self, code: str, status_code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.metadata = {"provider_error_type": code, "status_code": status_code}


class SwicoFreeUnavailableError(SwicoFreeProviderError):
    def __init__(self) -> None:
        super().__init__("swico_free_unavailable", 503, "Swico Free is temporarily unavailable.")


class SwicoFreeBusyError(SwicoFreeProviderError):
    def __init__(self) -> None:
        super().__init__("swico_free_busy", 429, "Swico Free is busy. Please try again shortly.")


class SwicoFreeTimeoutError(SwicoFreeProviderError):
    def __init__(self) -> None:
        super().__init__(
            "swico_free_timeout", 504,
            "Swico Free could not finish within the response-time limit.",
        )


SWICO_FREE_CONNECT_RETRIES_DEFAULT = 2
SWICO_FREE_CONNECT_RETRIES_MAX = 3


def _connect_retries() -> int:
    try:
        retries = int(os.getenv(
            "SWICO_FREE_CONNECT_RETRIES",
            str(SWICO_FREE_CONNECT_RETRIES_DEFAULT),
        ).strip())
    except (TypeError, ValueError) as exc:
        raise SwicoFreeUnavailableError() from exc
    if not 0 <= retries <= SWICO_FREE_CONNECT_RETRIES_MAX:
        raise SwicoFreeUnavailableError()
    return retries


class _VisibleTextFilter:
    _OPEN = "<think>"
    _CLOSE = "</think>"

    def __init__(self) -> None:
        self._buffer = ""
        self._thinking = False

    def feed(self, value: str) -> str:
        self._buffer += str(value or "")
        visible: list[str] = []
        while self._buffer:
            lowered = self._buffer.lower()
            tag = self._CLOSE if self._thinking else self._OPEN
            index = lowered.find(tag)
            if index >= 0:
                if not self._thinking:
                    visible.append(self._buffer[:index])
                self._buffer = self._buffer[index + len(tag):]
                self._thinking = not self._thinking
                continue
            prefixes = (self._CLOSE,) if self._thinking else (self._OPEN, self._CLOSE)
            keep = max(
                (size for prefix in prefixes for size in range(1, len(prefix))
                 if lowered.endswith(prefix[:size])),
                default=0,
            )
            if self._thinking:
                self._buffer = self._buffer[-keep:] if keep else ""
            elif keep:
                visible.append(self._buffer[:-keep])
                self._buffer = self._buffer[-keep:]
            else:
                visible.append(self._buffer)
                self._buffer = ""
            break
        return "".join(visible)

    def finish(self) -> str:
        if self._thinking:
            self._buffer = ""
            return ""
        value = self.feed("")
        lowered = self._buffer.lower()
        partial_tag = any(
            lowered == tag[:len(lowered)]
            for tag in (self._OPEN, self._CLOSE)
            if lowered
        )
        if not partial_tag:
            value += self._buffer
        self._buffer = ""
        return value


def _settings() -> tuple[str, str, float]:
    if os.getenv("SWICO_FREE_ENABLED", "false").strip().lower() not in {"1", "true", "yes", "on"}:
        raise SwicoFreeUnavailableError()
    base_url = os.getenv("SWICO_FREE_INFERENCE_BASE_URL", "").strip().rstrip("/")
    token = os.getenv("SWICO_FREE_INFERENCE_TOKEN", "").strip()
    try:
        timeout = float(os.getenv("SWICO_FREE_INFERENCE_TIMEOUT_SECONDS", "90"))
    except ValueError:
        timeout = 90.0
    if not base_url or not token or timeout <= 0 or timeout > 120:
        raise SwicoFreeUnavailableError()
    return base_url, token, timeout


def _safe_usage(payload: Any, text: str, prompt: str) -> tuple[int, int]:
    usage = payload.get("usage") if isinstance(payload, dict) else None
    usage = usage if isinstance(usage, dict) else payload if isinstance(payload, dict) else {}
    input_tokens = int(usage.get("input_tokens") or usage.get("prompt_tokens") or max(1, len(prompt.encode("utf-8")) // 3))
    output_tokens = int(usage.get("output_tokens") or usage.get("completion_tokens") or max(1, len(text.encode("utf-8")) // 3))
    return max(0, input_tokens), max(0, output_tokens)


def _messages(request: AIRequest, route: AIRoute) -> list[dict[str, str]]:
    return [
        {"role": str(item.get("role") or "user"), "content": str(item.get("content") or "")}
        for item in build_provider_messages(request, route, provider="swico_free")
    ]


class SwicoFreeProvider(AIProvider):
    """Authenticated Render-to-laptop provider with no paid-provider fallback."""

    def _client(self, base_url: str, token: str, timeout: float) -> httpx.Client:
        return httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=httpx.Timeout(timeout, connect=min(10.0, timeout)),
            transport=httpx.HTTPTransport(retries=_connect_retries()),
        )

    def _post(self, endpoint: str, payload: dict[str, Any]) -> httpx.Response:
        base_url, token, timeout = _settings()
        try:
            with self._client(base_url, token, timeout) as client:
                response = client.post(endpoint, json=payload)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError) as exc:
            raise SwicoFreeUnavailableError() from exc
        if response.status_code == 429:
            raise SwicoFreeBusyError()
        if response.status_code == 504:
            raise SwicoFreeTimeoutError()
        if response.status_code >= 400:
            raise SwicoFreeUnavailableError()
        return response

    def complete(self, request: AIRequest, route: AIRoute) -> AIProviderResponse:
        messages = _messages(request, route)
        prompt = serialize_provider_messages(messages)
        response = self._post("/v1/generate", {
            "messages": messages,
            "max_output_tokens": min(512, max(1, int(route.max_output_tokens))),
        })
        try:
            payload = response.json()
        except ValueError as exc:
            raise SwicoFreeUnavailableError() from exc
        raw_text = str(payload.get("text") or payload.get("output") or "")
        visible_filter = _VisibleTextFilter()
        text = (visible_filter.feed(raw_text) + visible_filter.finish()).strip()
        if not text:
            raise SwicoFreeUnavailableError()
        input_tokens, output_tokens = _safe_usage(payload, text, prompt)
        finish_reason = str(payload.get("finish_reason") or "stop").strip().lower()
        truncated = bool(payload.get("truncated")) or finish_reason == "length"
        return AIProviderResponse(
            text=text, provider="swico_free", model=None, route=route.route,
            reason=route.reason, language=route.language, intent=route.intent,
            input_tokens=input_tokens, output_tokens=output_tokens,
            characters=len(text), estimated_cost_amount=0,
            estimated_cost_currency="INR",
            raw={"usage_actual": bool(payload.get("usage")), "provider_attempts": 1,
                 "provider_calls_with_usage": 1 if payload.get("usage") else 0,
                 "fallback_attempted": False, "finish_reason": finish_reason,
                 "truncated": truncated,
                 "completion_status": "incomplete" if truncated else "complete"},
        )

    def embed(self, values: list[str], *, mode: str = "passage") -> list[list[float]]:
        if mode not in {"query", "passage"}:
            raise ValueError("Unsupported Swico Free embedding mode")
        response = self._post("/v1/embed", {
            "texts": [str(value) for value in values],
            "modes": [mode for _ in values],
        })
        try:
            payload = response.json()
            vectors = payload.get("vectors") if isinstance(payload, dict) else None
        except ValueError as exc:
            raise SwicoFreeUnavailableError() from exc
        if not isinstance(vectors, list) or len(vectors) != len(values):
            raise SwicoFreeUnavailableError()
        normalized: list[list[float]] = []
        for vector in vectors:
            if not isinstance(vector, list) or len(vector) != 384:
                raise SwicoFreeUnavailableError()
            normalized.append([float(item) for item in vector])
        return normalized

    def stream_complete(
        self, request: AIRequest, route: AIRoute, on_delta: Callable[[str], None]
    ) -> AIProviderResponse:
        base_url, token, timeout = _settings()
        messages = _messages(request, route)
        prompt = serialize_provider_messages(messages)
        cancellation = request.metadata.get("cancellation_signal")
        if isinstance(cancellation, GenerationCancellation) and cancellation.cancelled:
            raise GenerationCancelled()
        parts: list[str] = []
        usage: dict[str, Any] = {}
        visible_filter = _VisibleTextFilter()
        try:
            with self._client(base_url, token, timeout) as client:
                with client.stream(
                    "POST", "/v1/generate/stream",
                    headers={"Accept": "text/event-stream"},
                    json={"messages": messages, "max_output_tokens": min(512, max(1, int(route.max_output_tokens)))},
                ) as response:
                    if isinstance(cancellation, GenerationCancellation):
                        cancellation.bind_stream(response)
                    if response.status_code == 429:
                        raise SwicoFreeBusyError()
                    if response.status_code == 504:
                        raise SwicoFreeTimeoutError()
                    if response.status_code >= 400:
                        raise SwicoFreeUnavailableError()
                    for line in response.iter_lines():
                        if isinstance(cancellation, GenerationCancellation) and cancellation.cancelled:
                            text = "".join(parts).strip()
                            raise GenerationCancelled(
                                AIProviderResponse(
                                    text=text, provider="swico_free", model=None, route=route.route,
                                    reason=route.reason, language=route.language, intent=route.intent,
                                    input_tokens=int(usage.get("input_tokens") or 0),
                                    output_tokens=int(usage.get("output_tokens") or max(0, len(text.encode("utf-8")) // 3)),
                                    characters=len(text), raw={"cancelled": True, "usage_actual": bool(usage)},
                                ) if text else None
                            )
                        value = str(line or "")
                        if not value.startswith("data:"):
                            continue
                        data = value[5:].strip()
                        if not data or data == "[DONE]":
                            continue
                        try:
                            event = json.loads(data)
                        except json.JSONDecodeError:
                            raise SwicoFreeUnavailableError()
                        if isinstance(event, dict) and isinstance(event.get("usage"), dict):
                            usage.update(event["usage"])
                        if isinstance(event, dict) and event.get("error"):
                            if str(event.get("error")).strip().lower() == "swico_free_timeout":
                                raise SwicoFreeTimeoutError()
                            raise SwicoFreeUnavailableError()
                        if isinstance(event, dict) and event.get("finish_reason"):
                            usage["finish_reason"] = str(event["finish_reason"]).strip().lower()
                            usage["truncated"] = bool(event.get("truncated")) or usage["finish_reason"] == "timeout"
                            if usage["finish_reason"] == "cancelled":
                                partial = "".join(parts).strip()
                                raise GenerationCancelled(
                                    AIProviderResponse(
                                        text=partial, provider="swico_free", model=None,
                                        route=route.route, reason=route.reason,
                                        language=route.language, intent=route.intent,
                                        characters=len(partial), raw={"cancelled": True},
                                    ) if partial else None
                                )
                        delta = event.get("delta") if isinstance(event, dict) else None
                        if delta is None and isinstance(event, dict):
                            delta = event.get("text")
                        if delta:
                            chunk = visible_filter.feed(str(delta))
                            if chunk:
                                parts.append(chunk)
                                on_delta(chunk)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError) as exc:
            raise SwicoFreeUnavailableError() from exc
        finally:
            if isinstance(cancellation, GenerationCancellation):
                cancellation.unbind_stream(locals().get("response"))
        tail = visible_filter.finish()
        if tail:
            parts.append(tail)
            on_delta(tail)
        text = "".join(parts).strip()
        if not text:
            raise SwicoFreeUnavailableError()
        input_tokens, output_tokens = _safe_usage(usage, text, prompt)
        finish_reason = str(usage.get("finish_reason") or "stop").strip().lower()
        truncated = bool(usage.get("truncated")) or finish_reason == "length"
        return AIProviderResponse(
            text=text, provider="swico_free", model=None, route=route.route,
            reason=route.reason, language=route.language, intent=route.intent,
            input_tokens=input_tokens, output_tokens=output_tokens,
            characters=len(text), estimated_cost_amount=0,
            estimated_cost_currency="INR",
            raw={"usage_actual": bool(usage), "provider_attempts": 1,
                 "provider_calls_with_usage": 1 if usage else 0,
                 "fallback_attempted": False, "finish_reason": finish_reason,
                 "truncated": truncated,
                 "completion_status": "incomplete" if truncated or finish_reason == "timeout" else "complete"},
        )
