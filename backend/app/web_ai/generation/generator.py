from __future__ import annotations

from dataclasses import dataclass, replace
from collections.abc import Callable

from ...ai.providers.base import GenerationCancelled
from ...ai.types import AIProviderResponse
from ..streaming_policy import StreamingPolicy
from .models import AnswerQualityResult


@dataclass(frozen=True)
class GeneratedAnswer:
    response: AIProviderResponse
    quality: AnswerQualityResult | None
    repair_attempts: int = 0


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)


def _check_cancelled(signal: object | None) -> None:
    if _cancelled(signal):
        raise GenerationCancelled()


class VerifiedGenerator:
    def __init__(self, policy: StreamingPolicy):
        self.policy = policy

    def generate(
        self,
        *,
        generate_draft: Callable[[Callable[[str], None] | None], AIProviderResponse],
        verify: Callable[[str], AnswerQualityResult] | None,
        repair: Callable[[str, AnswerQualityResult], AIProviderResponse | None] | None,
        verify_repaired: Callable[[str, AnswerQualityResult], AnswerQualityResult] | None,
        on_delta: Callable[[str], None] | None,
        on_status: Callable[[str], None] | None,
        cancellation_signal: object | None,
        verify_final: Callable[
            [str, AnswerQualityResult | None], AnswerQualityResult
        ] | None = None,
    ) -> GeneratedAnswer:
        def status(value: str) -> None:
            if on_status:
                on_status(value)

        _check_cancelled(cancellation_signal)
        if self.policy.mode == "direct":
            response = generate_draft(on_delta)
            _check_cancelled(cancellation_signal)
            quality = verify(response.text) if verify else None
            if verify_final is not None:
                quality = verify_final(response.text, quality)
            return GeneratedAnswer(response=response, quality=quality)

        status("generating")
        size = 0

        def buffer(chunk: str) -> None:
            nonlocal size
            _check_cancelled(cancellation_signal)
            size += len(chunk)
            if size > self.policy.max_buffer_characters:
                cancel = getattr(cancellation_signal, "cancel", None)
                if callable(cancel):
                    cancel()
                raise GenerationCancelled()

        response = generate_draft(buffer)
        _check_cancelled(cancellation_signal)
        status("verifying_sources")
        quality = verify(response.text) if verify else None
        _check_cancelled(cancellation_signal)
        attempts = 0
        if quality and not quality.passed and repair is not None:
            status("repairing")
            attempts = 1
            repaired = repair(response.text, quality)
            _check_cancelled(cancellation_signal)
            if repaired is not None:
                response = repaired
                quality = (
                    verify_repaired(response.text, quality)
                    if verify_repaired else verify(response.text) if verify else quality
                )
            else:
                quality = replace(quality, repair_attempted=True)
        if verify_final is not None:
            quality = verify_final(response.text, quality)
        _check_cancelled(cancellation_signal)
        status("responding")
        if on_delta:
            on_delta(response.text)
        return GeneratedAnswer(
            response=response,
            quality=quality,
            repair_attempts=attempts,
        )
