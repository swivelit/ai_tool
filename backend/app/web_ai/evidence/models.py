from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EvidenceItem:
    evidence_id: str
    owner_user_id: int
    source_type: str
    source_id: str
    ordinal: int
    estimated_tokens: int
    relevance_score: float
    citation_label: str = ""
    safe_attributes: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if self.owner_user_id <= 0:
            raise ValueError("owner_user_id must be positive")
        if self.ordinal < 0 or self.estimated_tokens < 0:
            raise ValueError("ordinal and estimated_tokens must be non-negative")
        if not 0.0 <= self.relevance_score <= 1.0:
            raise ValueError("relevance_score must be between zero and one")

    def belongs_to(self, user_id: int) -> bool:
        return self.owner_user_id == int(user_id)


@dataclass(frozen=True)
class EvidencePack:
    owner_user_id: int
    request_id: str
    items: tuple[EvidenceItem, ...] = ()
    total_estimated_tokens: int = 0
    truncated: bool = False

    def __post_init__(self) -> None:
        if self.owner_user_id <= 0:
            raise ValueError("owner_user_id must be positive")
        if self.total_estimated_tokens < 0:
            raise ValueError("total_estimated_tokens must be non-negative")
        if any(not item.belongs_to(self.owner_user_id) for item in self.items):
            raise ValueError("evidence pack cannot mix owners")
