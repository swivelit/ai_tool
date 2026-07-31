from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast


TierId = Literal["lite", "standard", "pro"]


@dataclass(frozen=True)
class TierPolicy:
    """Validated ceilings used only by Phase 1 planning."""

    tier_id: TierId
    max_prompt_tokens: int
    max_output_tokens: int
    max_history_tokens: int
    max_memory_tokens: int
    max_profile_tokens: int
    max_document_tokens: int
    max_retrieval_candidates: int
    max_evidence_items: int
    max_provider_calls: int = 1

    def __post_init__(self) -> None:
        numeric = (
            self.max_prompt_tokens,
            self.max_output_tokens,
            self.max_history_tokens,
            self.max_memory_tokens,
            self.max_profile_tokens,
            self.max_document_tokens,
            self.max_retrieval_candidates,
            self.max_evidence_items,
            self.max_provider_calls,
        )
        if any(value < 0 for value in numeric):
            raise ValueError("tier-policy ceilings must be non-negative")
        if self.max_prompt_tokens < 256 or self.max_prompt_tokens > 128_000:
            raise ValueError("max_prompt_tokens is outside the supported bounds")
        if self.max_output_tokens > self.max_prompt_tokens:
            raise ValueError("max_output_tokens cannot exceed max_prompt_tokens")
        if self.max_provider_calls > 2:
            raise ValueError("max_provider_calls exceeds the Phase 1 safety bound")
        for source_limit in (
            self.max_history_tokens,
            self.max_memory_tokens,
            self.max_profile_tokens,
            self.max_document_tokens,
        ):
            if source_limit > self.max_prompt_tokens:
                raise ValueError("source ceiling cannot exceed max_prompt_tokens")


_TIER_POLICIES: dict[TierId, TierPolicy] = {
    "lite": TierPolicy(
        tier_id="lite",
        max_prompt_tokens=6_000,
        max_output_tokens=1_800,
        max_history_tokens=2_400,
        max_memory_tokens=900,
        max_profile_tokens=600,
        max_document_tokens=2_400,
        max_retrieval_candidates=12,
        max_evidence_items=6,
    ),
    "standard": TierPolicy(
        tier_id="standard",
        max_prompt_tokens=12_000,
        max_output_tokens=4_000,
        max_history_tokens=4_800,
        max_memory_tokens=1_800,
        max_profile_tokens=900,
        max_document_tokens=5_400,
        max_retrieval_candidates=24,
        max_evidence_items=12,
    ),
    "pro": TierPolicy(
        tier_id="pro",
        max_prompt_tokens=24_000,
        max_output_tokens=6_000,
        max_history_tokens=8_000,
        max_memory_tokens=3_600,
        max_profile_tokens=1_200,
        max_document_tokens=12_000,
        max_retrieval_candidates=40,
        max_evidence_items=20,
    ),
}


def tier_policy_for(tier: object) -> TierPolicy:
    normalized = str(tier or "lite").strip().lower()
    if normalized not in _TIER_POLICIES:
        normalized = "lite"
    return _TIER_POLICIES[cast(TierId, normalized)]


def validated_tier_policies() -> tuple[TierPolicy, ...]:
    policies = tuple(_TIER_POLICIES[tier] for tier in ("lite", "standard", "pro"))
    for policy in policies:
        policy.__post_init__()
    return policies
