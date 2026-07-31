from __future__ import annotations

from dataclasses import dataclass


SafeMetadata = tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class RetrievalCandidate:
    """Runtime retrieval result.

    ``runtime_text`` is deliberately excluded from every serialization helper.
    It may live only for the duration of a request.
    """

    candidate_id: str
    owner_user_id: int
    source_kind: str = ""
    source_locator: str = ""
    runtime_text: str = ""
    token_count: int = 0
    lexical_score: float = 0.0
    semantic_score: float = 0.0
    metadata_score: float = 0.0
    fused_score: float = 0.0
    content_hash: str = ""
    bounded_metadata: SafeMetadata = ()
    rank: int = 0
    reason_codes: tuple[str, ...] = ()
    # Compatibility names retained for Phase 1 callers.
    source_type: str = ""
    source_id: str = ""
    score: float = 0.0
    estimated_tokens: int = 0

    def __post_init__(self) -> None:
        if self.owner_user_id <= 0:
            raise ValueError("owner_user_id must be positive")
        canonical_kind = self.source_kind or self.source_type
        canonical_locator = self.source_locator or self.source_id
        canonical_tokens = self.token_count or self.estimated_tokens
        canonical_score = self.fused_score or self.score
        object.__setattr__(self, "source_kind", canonical_kind)
        object.__setattr__(self, "source_type", canonical_kind)
        object.__setattr__(self, "source_locator", canonical_locator)
        object.__setattr__(self, "source_id", canonical_locator)
        object.__setattr__(self, "token_count", canonical_tokens)
        object.__setattr__(self, "estimated_tokens", canonical_tokens)
        object.__setattr__(self, "fused_score", canonical_score)
        object.__setattr__(self, "score", canonical_score)
        scores = (
            self.lexical_score,
            self.semantic_score,
            self.metadata_score,
            self.fused_score,
        )
        if any(not 0.0 <= value <= 1.0 for value in scores):
            raise ValueError("retrieval scores must be between zero and one")
        if self.token_count < 0 or self.rank < 0:
            raise ValueError("token count and rank must be non-negative")
        if len(self.bounded_metadata) > 16:
            raise ValueError("bounded_metadata exceeds the item limit")
        if any(len(key) > 64 or len(value) > 256 for key, value in self.bounded_metadata):
            raise ValueError("bounded_metadata contains an oversized value")

    def belongs_to(self, user_id: int) -> bool:
        return self.owner_user_id == int(user_id)

    @property
    def safe_metadata(self) -> dict[str, object]:
        return {
            "candidate_id": self.candidate_id,
            "source_kind": self.source_kind,
            "source_locator": self.source_locator,
            "token_count": self.token_count,
            "lexical_score": round(self.lexical_score, 6),
            "semantic_score": round(self.semantic_score, 6),
            "metadata_score": round(self.metadata_score, 6),
            "fused_score": round(self.fused_score, 6),
            "content_hash": self.content_hash,
            "rank": self.rank,
            "reason_codes": list(self.reason_codes),
            "metadata": dict(self.bounded_metadata),
        }
