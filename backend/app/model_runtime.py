from __future__ import annotations

import random
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

import openai as openai_module

from .observability import bootstrap_observability

bootstrap_observability()

RAW_OPENAI = openai_module.OpenAI


class CircuitBreakerOpen(Exception):
    pass


@dataclass
class CircuitState:
    failures: int = 0
    opened_until: float = 0.0


class CircuitBreaker:
    def __init__(self, *, threshold: int = 5, recovery_seconds: int = 30) -> None:
        self.threshold = max(1, int(threshold))
        self.recovery_seconds = max(1, int(recovery_seconds))
        self.state = CircuitState()
        self._lock = threading.Lock()

    def before_call(self) -> None:
        with self._lock:
            now = time.time()
            if self.state.opened_until > now:
                raise CircuitBreakerOpen(
                    f"model circuit open for {round(self.state.opened_until - now, 1)}s"
                )
            if self.state.opened_until and self.state.opened_until <= now:
                self.state.failures = 0
                self.state.opened_until = 0.0

    def record_success(self) -> None:
        with self._lock:
            self.state.failures = 0
            self.state.opened_until = 0.0

    def record_failure(self) -> None:
        with self._lock:
            self.state.failures += 1
            if self.state.failures >= self.threshold:
                self.state.opened_until = time.time() + self.recovery_seconds


class ResilientEndpointProxy:
    def __init__(
        self,
        target: Any,
        *,
        breaker: CircuitBreaker,
        timeout_seconds: float,
        max_retries: int,
        backoff_seconds: float,
    ) -> None:
        self._target = target
        self._breaker = breaker
        self._timeout_seconds = timeout_seconds
        self._max_retries = max(1, int(max_retries))
        self._backoff_seconds = max(0.1, float(backoff_seconds))

    def create(self, **kwargs: Any) -> Any:
        return self._call(self._target.create, **kwargs)

    def stream(self, **kwargs: Any) -> Any:
        return self._call(self._target.stream, **kwargs)

    def _call(self, func: Callable[..., Any], **kwargs: Any) -> Any:
        last_error: Optional[Exception] = None
        timeout = kwargs.pop("timeout", None) or self._timeout_seconds
        for attempt in range(1, self._max_retries + 1):
            try:
                self._breaker.before_call()
                response = func(timeout=timeout, **kwargs)
                self._breaker.record_success()
                return response
            except Exception as exc:  # pragma: no cover
                last_error = exc
                self._breaker.record_failure()
                if attempt >= self._max_retries:
                    break
                sleep_for = min(self._backoff_seconds * (2 ** (attempt - 1)) + random.uniform(0.0, 0.25), 8.0)
                time.sleep(sleep_for)
        raise last_error or RuntimeError("OpenAI call failed")


class ResilientOpenAI:
    def __init__(self, *args: Any, timeout: Optional[float] = None, **kwargs: Any) -> None:
        self._raw = RAW_OPENAI(*args, timeout=timeout, **kwargs)
        breaker = CircuitBreaker(
            threshold=int(kwargs.pop("circuit_breaker_threshold", 5) or 5),
            recovery_seconds=int(kwargs.pop("circuit_breaker_recovery_seconds", 30) or 30),
        )
        timeout_seconds = float(timeout or 60.0)
        retries = int(kwargs.pop("max_retries", 3) or 3)
        backoff = float(kwargs.pop("backoff_seconds", 0.8) or 0.8)

        self.responses = ResilientEndpointProxy(
            self._raw.responses,
            breaker=breaker,
            timeout_seconds=timeout_seconds,
            max_retries=retries,
            backoff_seconds=backoff,
        )
        self.embeddings = ResilientEndpointProxy(
            self._raw.embeddings,
            breaker=breaker,
            timeout_seconds=timeout_seconds,
            max_retries=retries,
            backoff_seconds=backoff,
        )
        self.audio = type("AudioProxy", (), {})()
        self.audio.transcriptions = ResilientEndpointProxy(
            self._raw.audio.transcriptions,
            breaker=breaker,
            timeout_seconds=max(timeout_seconds, 180.0),
            max_retries=max(1, retries),
            backoff_seconds=backoff,
        )

    def __getattr__(self, item: str) -> Any:
        return getattr(self._raw, item)


_PATCHED = False


def patch_openai_client() -> None:
    global _PATCHED
    if _PATCHED:
        return
    openai_module.OpenAI = ResilientOpenAI
    _PATCHED = True