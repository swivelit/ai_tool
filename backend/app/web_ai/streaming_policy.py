from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


StreamingPolicyMode = Literal["direct", "verified_buffered"]


@dataclass(frozen=True)
class StreamingPolicy:
    mode: StreamingPolicyMode
    max_buffer_characters: int = 200_000

    def __post_init__(self) -> None:
        if self.max_buffer_characters < 1_000 or self.max_buffer_characters > 1_000_000:
            raise ValueError("verified streaming buffer is outside supported bounds")


def select_streaming_policy(
    *,
    answer_guard_enabled: bool,
    verified_streaming_enabled: bool,
    has_evidence: bool,
    answer_class: str,
    max_buffer_characters: int,
) -> StreamingPolicy:
    needs_buffering = bool(
        answer_guard_enabled
        and verified_streaming_enabled
        and (
            has_evidence
            or str(answer_class).lower() in {"detailed", "long_form"}
        )
    )
    return StreamingPolicy(
        mode="verified_buffered" if needs_buffering else "direct",
        max_buffer_characters=max_buffer_characters,
    )
