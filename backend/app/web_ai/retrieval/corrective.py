from __future__ import annotations

from dataclasses import dataclass

from ..tier_policy import TierPolicy


@dataclass
class CorrectiveRetrievalController:
    policy: TierPolicy
    configured_max_rounds: int = 1
    completed_rounds: int = 0

    @property
    def maximum_rounds(self) -> int:
        if not self.policy.corrective_retrieval_allowed:
            return 0
        tier_limit = 2 if self.policy.tier_id == "pro" else 1
        return min(
            tier_limit,
            max(0, int(self.configured_max_rounds)),
        )

    def next_query(self, *, query: str, status: str) -> str | None:
        if status not in {"insufficient", "ambiguous"}:
            return None
        if self.completed_rounds >= self.maximum_rounds:
            return None
        self.completed_rounds += 1
        # No LLM rewrite: a stable lexical broadening marker is used only to
        # select the next bounded query variant.
        return " ".join(str(query or "").split())[:2_000]
