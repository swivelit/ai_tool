from __future__ import annotations

from dataclasses import dataclass
from math import floor
from typing import Mapping

from .tier_policy import TierPolicy


_SOURCES = ("history", "memory", "profile", "documents")
_WEIGHTS = {
    "history": 0.30,
    "memory": 0.20,
    "profile": 0.15,
    "documents": 0.35,
}


@dataclass(frozen=True)
class TokenAllocation:
    prompt_ceiling: int
    fixed_tokens: int
    history_tokens: int = 0
    memory_tokens: int = 0
    profile_tokens: int = 0
    document_tokens: int = 0
    unallocated_tokens: int = 0

    @property
    def allocated_context_tokens(self) -> int:
        return (
            self.history_tokens
            + self.memory_tokens
            + self.profile_tokens
            + self.document_tokens
        )

    @property
    def total_tokens(self) -> int:
        return self.fixed_tokens + self.allocated_context_tokens

    @property
    def sanitized_metadata(self) -> dict[str, int]:
        return {
            "prompt_ceiling": self.prompt_ceiling,
            "fixed_tokens": self.fixed_tokens,
            "history_tokens": self.history_tokens,
            "memory_tokens": self.memory_tokens,
            "profile_tokens": self.profile_tokens,
            "document_tokens": self.document_tokens,
            "unallocated_tokens": self.unallocated_tokens,
        }


class DynamicTokenAllocator:
    """Deterministically allocates a tier-bounded prompt budget.

    A source with zero relevance or zero available content always receives zero.
    The allocator does not truncate or mutate the active website prompt.
    """

    def __init__(self, policy: TierPolicy):
        self.policy = policy

    def allocate(
        self,
        *,
        fixed_tokens: int,
        relevance: Mapping[str, float | int | bool] | None = None,
        available_tokens: Mapping[str, int] | None = None,
        prompt_ceiling: int | None = None,
    ) -> TokenAllocation:
        requested_ceiling = (
            self.policy.max_prompt_tokens
            if prompt_ceiling is None
            else max(0, int(prompt_ceiling))
        )
        ceiling = min(self.policy.max_prompt_tokens, requested_ceiling)
        fixed = min(ceiling, max(0, int(fixed_tokens)))
        remaining = max(0, ceiling - fixed)
        scores = relevance or {}
        available = available_tokens or {}
        source_caps = {
            "history": self.policy.max_history_tokens,
            "memory": self.policy.max_memory_tokens,
            "profile": self.policy.max_profile_tokens,
            "documents": self.policy.max_document_tokens,
        }
        caps: dict[str, int] = {}
        weighted: dict[str, float] = {}
        for source in _SOURCES:
            score = min(1.0, max(0.0, float(scores.get(source, 0))))
            content_tokens = max(0, int(available.get(source, source_caps[source])))
            caps[source] = min(source_caps[source], content_tokens)
            weighted[source] = _WEIGHTS[source] * score if caps[source] else 0.0

        allocations = {source: 0 for source in _SOURCES}
        active = {source for source in _SOURCES if weighted[source] > 0}
        budget = remaining
        # Water-fill until no source can accept more. Stable source ordering and
        # deterministic remainder handling make identical inputs repeatable.
        while budget > 0 and active:
            total_weight = sum(weighted[source] for source in active)
            if total_weight <= 0:
                break
            raw = {
                source: budget * weighted[source] / total_weight
                for source in active
            }
            progressed = 0
            for source in _SOURCES:
                if source not in active:
                    continue
                room = caps[source] - allocations[source]
                grant = min(room, floor(raw[source]))
                if grant > 0:
                    allocations[source] += grant
                    progressed += grant
            budget -= progressed
            active = {
                source for source in active
                if allocations[source] < caps[source]
            }
            if budget <= 0 or not active:
                break
            if progressed == 0:
                ranked = sorted(
                    active,
                    key=lambda source: (
                        -(raw[source] - floor(raw[source])),
                        _SOURCES.index(source),
                    ),
                )
                for source in ranked:
                    if budget <= 0:
                        break
                    allocations[source] += 1
                    budget -= 1

        return TokenAllocation(
            prompt_ceiling=ceiling,
            fixed_tokens=fixed,
            history_tokens=allocations["history"],
            memory_tokens=allocations["memory"],
            profile_tokens=allocations["profile"],
            document_tokens=allocations["documents"],
            unallocated_tokens=budget,
        )
