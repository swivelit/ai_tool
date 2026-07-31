from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


RetrievalStatus = Literal[
    "sufficient",
    "ambiguous",
    "insufficient",
    "contradictory",
]


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
    source_label: str = ""
    source_locator: str = ""
    confidence: float = 0.0
    runtime_text: str = ""
    content_hash: str = ""

    def __post_init__(self) -> None:
        if self.owner_user_id <= 0:
            raise ValueError("owner_user_id must be positive")
        if self.ordinal < 0 or self.estimated_tokens < 0:
            raise ValueError("ordinal and estimated_tokens must be non-negative")
        if not 0.0 <= self.relevance_score <= 1.0:
            raise ValueError("relevance_score must be between zero and one")
        confidence = self.confidence or self.relevance_score
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("confidence must be between zero and one")
        object.__setattr__(self, "confidence", confidence)
        object.__setattr__(
            self, "source_locator", self.source_locator or self.source_id
        )
        object.__setattr__(
            self, "source_label", self.source_label or self.citation_label
        )
        if len(self.safe_attributes) > 16:
            raise ValueError("safe_attributes exceeds the item limit")

    def belongs_to(self, user_id: int) -> bool:
        return self.owner_user_id == int(user_id)

    @property
    def safe_source(self) -> dict[str, object]:
        return {
            "id": self.citation_label,
            "label": self.source_label,
            "locator": self.source_locator,
            "confidence": round(self.confidence, 6),
            "source_kind": self.source_type,
        }


@dataclass(frozen=True)
class EvidencePack:
    owner_user_id: int
    request_id: str
    items: tuple[EvidenceItem, ...] = ()
    total_estimated_tokens: int = 0
    truncated: bool = False
    retrieval_status: RetrievalStatus = "insufficient"
    contradictions: tuple[str, ...] = ()
    source_map: tuple[tuple[str, str], ...] = ()
    total_token_count: int = 0
    status_codes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        total = self.total_token_count or self.total_estimated_tokens
        object.__setattr__(self, "total_token_count", total)
        object.__setattr__(self, "total_estimated_tokens", total)
        if self.owner_user_id <= 0:
            raise ValueError("owner_user_id must be positive")
        if total < 0:
            raise ValueError("total token count must be non-negative")
        if any(not item.belongs_to(self.owner_user_id) for item in self.items):
            raise ValueError("evidence pack cannot mix owners")
        if len(self.contradictions) > 16 or len(self.source_map) > 32:
            raise ValueError("evidence metadata exceeds supported bounds")

    @property
    def safe_sources(self) -> tuple[dict[str, object], ...]:
        return tuple(item.safe_source for item in self.items)
