from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .token_allocator import TokenAllocation


PlanRoute = Literal[
    "deterministic",
    "cache_candidate",
    "provider_backed",
    "blocked",
]
StreamingMode = Literal[
    "existing_sse", "direct", "verified_buffered", "none",
]


@dataclass(frozen=True)
class ExecutionPlan:
    """Immutable, provider-neutral plan produced by deterministic triage."""

    policy_version: str
    tier_id: str
    route: PlanRoute
    intent: str
    answer_class: str
    reason_codes: tuple[str, ...]
    retrieval_sources: tuple[str, ...]
    token_allocation: TokenAllocation
    max_output_tokens: int
    expected_provider_calls: int
    cache_eligible: bool
    deterministic: bool
    streaming_mode: StreamingMode
    planned_usage_stages: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.expected_provider_calls < 0 or self.expected_provider_calls > 4:
            raise ValueError(
                "expected_provider_calls is outside the TRIAG-RAG bound"
            )
        if self.deterministic and self.expected_provider_calls:
            raise ValueError("deterministic plans cannot call a provider")
        if self.max_output_tokens < 0:
            raise ValueError("max_output_tokens must be non-negative")

    @property
    def sanitized_metadata(self) -> dict[str, object]:
        return {
            "policy_version": self.policy_version,
            "tier_id": self.tier_id,
            "route": self.route,
            "intent": self.intent,
            "answer_class": self.answer_class,
            "reason_codes": list(self.reason_codes),
            "retrieval_sources": list(self.retrieval_sources),
            "max_output_tokens": self.max_output_tokens,
            "expected_provider_calls": self.expected_provider_calls,
            "cache_eligible": self.cache_eligible,
            "deterministic": self.deterministic,
            "streaming_mode": self.streaming_mode,
            "planned_usage_stages": list(self.planned_usage_stages),
            "allocation": self.token_allocation.sanitized_metadata,
        }
