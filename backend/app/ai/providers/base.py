from __future__ import annotations

from abc import ABC, abstractmethod
from threading import Event, Lock
from typing import Any

from ..types import AIProviderResponse, AIRequest, AIRoute


class AIProvider(ABC):
    @abstractmethod
    def complete(self, request: AIRequest, route: AIRoute) -> AIProviderResponse:
        raise NotImplementedError


class GenerationCancellation:
    """Thread-safe cancellation state shared by an SSE request and provider worker."""

    def __init__(self) -> None:
        self._event = Event()
        self._lock = Lock()
        self._stream: Any | None = None

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def bind_stream(self, stream: Any) -> None:
        with self._lock:
            self._stream = stream
        if self.cancelled:
            self._close_stream(stream)

    def unbind_stream(self, stream: Any) -> None:
        with self._lock:
            if self._stream is stream:
                self._stream = None

    def cancel(self) -> None:
        self._event.set()
        with self._lock:
            stream = self._stream
        self._close_stream(stream)

    @staticmethod
    def _close_stream(stream: Any | None) -> None:
        close = getattr(stream, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass


class GenerationCancelled(RuntimeError):
    """Raised cooperatively by a provider worker after cancellation is requested."""

    def __init__(self, response: AIProviderResponse | None = None) -> None:
        super().__init__("Generation cancelled")
        self.response = response


class GenerationIncomplete(RuntimeError):
    """Raised when a provider spent the output budget before producing text."""

    def __init__(
        self,
        *,
        completion_status: str,
        incomplete_reason: str,
        finish_reason: str,
        input_tokens: int,
        output_tokens: int,
        reasoning_tokens: int,
        visible_characters: int,
        max_output_tokens: int,
        provider_usage_received: bool,
        reasoning_effort: str | None = None,
    ) -> None:
        super().__init__(
            "Generation incomplete: the response limit was reached before visible output."
        )
        self.metadata = {
            "completion_status": str(completion_status or "unknown"),
            "incomplete_reason": str(incomplete_reason or ""),
            "finish_reason": str(finish_reason or "unknown"),
            "input_tokens": max(0, int(input_tokens or 0)),
            "output_tokens": max(0, int(output_tokens or 0)),
            "reasoning_tokens": max(0, int(reasoning_tokens or 0)),
            "visible_character_count": max(0, int(visible_characters or 0)),
            "max_output_tokens": max(0, int(max_output_tokens or 0)),
            "provider_usage_received": bool(provider_usage_received),
            "reasoning_effort": str(reasoning_effort or ""),
        }


class ProviderSafetyRejected(RuntimeError):
    """Stable internal signal for a provider-side safety refusal."""

    def __init__(self, response: AIProviderResponse) -> None:
        super().__init__("Swico safety policy rejected the requested generation")
        self.response = response


class ProviderStreamInterrupted(RuntimeError):
    """A retryable transport interruption, optionally after visible output."""

    def __init__(
        self,
        *,
        response: AIProviderResponse | None,
        provider_attempts: int,
        visible_output_emitted: bool,
        provider_usage_received: bool,
        terminal_event_type: str = "",
        completion_status: str = "unknown",
        finish_reason: str = "unknown",
    ) -> None:
        super().__init__("Provider stream interrupted")
        self.response = response
        self.metadata = {
            "provider_attempts": max(0, int(provider_attempts or 0)),
            "visible_output_emitted": bool(visible_output_emitted),
            "visible_character_count": len(response.text) if response else 0,
            "provider_usage_received": bool(provider_usage_received),
            "terminal_event_type": str(terminal_event_type or ""),
            "completion_status": str(completion_status or "unknown"),
            "finish_reason": str(finish_reason or "unknown"),
        }
