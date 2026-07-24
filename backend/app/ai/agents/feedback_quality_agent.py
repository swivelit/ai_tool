from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session

from ...models import GlobalQACache
from ...time_utils import utc_now


@dataclass(frozen=True)
class FeedbackQualityResult:
    confidence: float
    tombstoned: bool


class FeedbackQualityAgent:
    def apply_negative_feedback(
        self,
        session: Session,
        row: GlobalQACache,
        amount: float = 0.15,
        *,
        tombstone_at_zero: bool = False,
    ) -> FeedbackQualityResult:
        row.confidence = max(0.0, float(row.confidence or 0.0) - max(0.0, amount))
        tombstoned = (
            row.confidence <= 0.0 if tombstone_at_zero else row.confidence < 0.35
        )
        if tombstoned:
            row.status = "rejected"
            row.review_notes = ((row.review_notes or "") + "\nnegative_feedback_threshold").strip()
        row.updated_at = utc_now()
        session.add(row)
        session.commit()
        if tombstoned and row.id is not None:
            from ...global_qa_cache import record_global_qa_tombstone

            record_global_qa_tombstone(session, int(row.id), reason="negative_feedback_threshold")
        return FeedbackQualityResult(row.confidence, tombstoned)
