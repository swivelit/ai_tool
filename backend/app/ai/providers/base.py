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
