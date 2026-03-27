from __future__ import annotations

import logging
import os
import random
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional, Tuple, Type

import openai as openai_module

from .observability import bootstrap_observability

bootstrap_observability()
logger = logging.getLogger(__name__)
RAW_OPENAI = openai_module.OpenAI


class CircuitBreakerOpen(RuntimeError):
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
                raise CircuitBreakerOpen(f"model circuit open for {round(self.state.opened_until - now, 1)}s")
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


_RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}


def _exception_types(*names: str) -> Tuple[Type[BaseException], ...]:
    resolved = []
    for name in names:
        exc_type = getattr(openai_module, name, None)
        if isinstance(exc_type, type) and issubclass(exc_type, BaseException):
            resolved.append(exc_type)
    return tuple(resolved)


_RETRYABLE_EXCEPTIONS: Tuple[Type[BaseException], ...] = _exception_types(
    "APIConnectionError",
    "APITimeoutError",
    "RateLimitError",
    "InternalServerError",
)
_NON_RETRYABLE_EXCEPTIONS: Tuple[Type[BaseException], ...] = _exception_types(
    "BadRequestError",
    "AuthenticationError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "UnprocessableEntityError",
)
_STATUS_ERROR_EXCEPTIONS: Tuple[Type[BaseException], ...] = _exception_types("APIStatusError")


def _status_code_from_exception(exc: BaseException) -> Optional[int]:
    status_code = getattr(exc, "status_code", None)
    try:
        return int(status_code) if status_code is not None else None
    except Exception:
        return None


def _is_retryable_exception(exc: BaseException) -> bool:
    if isinstance(exc, CircuitBreakerOpen):
        return False
    if _NON_RETRYABLE_EXCEPTIONS and isinstance(exc, _NON_RETRYABLE_EXCEPTIONS):
        return False
    if _RETRYABLE_EXCEPTIONS and isinstance(exc, _RETRYABLE_EXCEPTIONS):
        return True
    if _STATUS_ERROR_EXCEPTIONS and isinstance(exc, _STATUS_ERROR_EXCEPTIONS):
        return (_status_code_from_exception(exc) or 0) in _RETRYABLE_STATUS_CODES
    status_code = _status_code_from_exception(exc)
    if status_code is not None:
        return status_code in _RETRYABLE_STATUS_CODES
    return True


class ResilientEndpointProxy:
    def __init__(
        self,
        target: Any,
        *,
        endpoint_name: str,
        breaker: CircuitBreaker,
        timeout_seconds: float,
        max_retries: int,
        backoff_seconds: float,
    ) -> None:
        self._target = target
        self._endpoint_name = endpoint_name
        self._breaker = breaker
        self._timeout_seconds = max(1.0, float(timeout_seconds))
        self._max_retries = max(1, int(max_retries))
        self._backoff_seconds = max(0.05, float(backoff_seconds))

    def create(self, **kwargs: Any) -> Any:
        return self._call(self._target.create, operation="create", **kwargs)

    def stream(self, **kwargs: Any) -> Any:
        return self._call(self._target.stream, operation="stream", **kwargs)

    def _call(self, func: Callable[..., Any], *, operation: str, **kwargs: Any) -> Any:
        timeout = kwargs.pop("timeout", None) or self._timeout_seconds
        last_error: Optional[BaseException] = None

        for attempt in range(1, self._max_retries + 1):
            try:
                self._breaker.before_call()
                response = func(timeout=timeout, **kwargs)
                self._breaker.record_success()
                if attempt > 1:
                    logger.info(
                        "model call succeeded after retry",
                        extra={
                            "attempt": attempt,
                            "endpoint": self._endpoint_name,
                            "operation": operation,
                        },
                    )
                return response
            except BaseException as exc:  # pragma: no cover - depends on network/provider failures
                last_error = exc
                retryable = _is_retryable_exception(exc)
                if retryable:
                    self._breaker.record_failure()

                logger.warning(
                    "model call failed",
                    extra={
                        "attempt": attempt,
                        "endpoint": self._endpoint_name,
                        "operation": operation,
                    },
                    exc_info=True,
                )

                if not retryable or attempt >= self._max_retries:
                    break

                sleep_for = min(
                    self._backoff_seconds * (2 ** (attempt - 1)) + random.uniform(0.0, 0.25),
                    8.0,
                )
                time.sleep(sleep_for)

        raise last_error or RuntimeError("OpenAI call failed")


class ResilientOpenAI:
    def __init__(self, *args: Any, timeout: Optional[float] = None, **kwargs: Any) -> None:
        threshold = int(kwargs.pop("circuit_breaker_threshold", os.getenv("OPENAI_CIRCUIT_BREAKER_THRESHOLD", "5") or 5))
        recovery_seconds = int(
            kwargs.pop("circuit_breaker_recovery_seconds", os.getenv("OPENAI_CIRCUIT_BREAKER_RECOVERY_SECONDS", "30") or 30)
        )
        retries = int(kwargs.pop("max_retries", os.getenv("OPENAI_MAX_RETRIES", "3") or 3))
        backoff = float(kwargs.pop("backoff_seconds", os.getenv("OPENAI_BACKOFF_BASE_SECONDS", "0.8") or 0.8))
        timeout_seconds = float(timeout or os.getenv("OPENAI_TIMEOUT", "60") or 60)

        self._raw = RAW_OPENAI(*args, timeout=timeout_seconds, **kwargs)
        breaker = CircuitBreaker(threshold=threshold, recovery_seconds=recovery_seconds)

        self.responses = ResilientEndpointProxy(
            self._raw.responses,
            endpoint_name="responses",
            breaker=breaker,
            timeout_seconds=timeout_seconds,
            max_retries=retries,
            backoff_seconds=backoff,
        )
        self.embeddings = ResilientEndpointProxy(
            self._raw.embeddings,
            endpoint_name="embeddings",
            breaker=breaker,
            timeout_seconds=timeout_seconds,
            max_retries=retries,
            backoff_seconds=backoff,
        )
        self.audio = type("AudioProxy", (), {})()
        self.audio.transcriptions = ResilientEndpointProxy(
            self._raw.audio.transcriptions,
            endpoint_name="audio.transcriptions",
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