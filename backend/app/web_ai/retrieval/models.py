from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RetrievalCandidate:
    candidate_id: str
    owner_user_id: int
    source_type: str
    source_id: str
    score: float
    estimated_tokens: int
    rank: int
    reason_codes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.owner_user_id <= 0:
            raise ValueError("owner_user_id must be positive")
        if not 0.0 <= self.score <= 1.0:
            raise ValueError("score must be between zero and one")
        if self.estimated_tokens < 0 or self.rank < 0:
            raise ValueError("token count and rank must be non-negative")

    def belongs_to(self, user_id: int) -> bool:
        return self.owner_user_id == int(user_id)
