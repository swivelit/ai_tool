from __future__ import annotations

from dataclasses import dataclass
import json
import os

from sqlmodel import Session

from ...models import GlobalQACache, WebChatMessage
from ...time_utils import utc_now


@dataclass(frozen=True)
class FeedbackQualityResult:
    confidence: float
    tombstoned: bool


class FeedbackQualityAgent:
    @staticmethod
    def confidence_floor() -> float:
        try:
            return max(
                0.0,
                min(
                    1.0,
                    float(os.getenv("GLOBAL_QA_CONFIDENCE_FLOOR", "0.35")),
                ),
            )
        except (TypeError, ValueError):
            return 0.35

    @staticmethod
    def confidence_maximum() -> float:
        try:
            return max(
                FeedbackQualityAgent.confidence_floor(),
                min(
                    1.0,
                    float(os.getenv("GLOBAL_QA_CONFIDENCE_MAX", "1.0")),
                ),
            )
        except (TypeError, ValueError):
            return 1.0

    def apply_negative_feedback(
        self,
        session: Session,
        row: GlobalQACache,
        amount: float = 0.15,
        *,
        tombstone_at_zero: bool = False,
        commit: bool = True,
    ) -> FeedbackQualityResult:
        row.confidence = max(0.0, float(row.confidence or 0.0) - max(0.0, amount))
        floor = 0.0 if tombstone_at_zero else self.confidence_floor()
        tombstoned = row.confidence <= floor
        if tombstoned:
            row.status = "rejected"
            row.review_notes = ((row.review_notes or "") + "\nnegative_feedback_threshold").strip()
        row.updated_at = utc_now()
        session.add(row)
        if tombstoned and row.id is not None:
            from ...global_qa_cache import record_global_qa_tombstone

            record_global_qa_tombstone(
                session,
                int(row.id),
                reason="negative_feedback_threshold",
                commit=False,
            )
        if commit:
            session.commit()
        return FeedbackQualityResult(row.confidence, tombstoned)

    def apply_message_negative_once(
        self,
        session: Session,
        message: WebChatMessage,
        *,
        action: str,
        amount: float = 0.15,
        commit: bool = True,
    ) -> FeedbackQualityResult | None:
        try:
            metadata = json.loads(message.metadata_json or "{}")
        except (TypeError, ValueError):
            metadata = {}
        metadata = metadata if isinstance(metadata, dict) else {}
        actions = [
            str(value) for value in metadata.get("cache_correction_actions", [])
            if str(value)
        ] if isinstance(metadata.get("cache_correction_actions", []), list) else []
        marker = f"negative:{str(action or '').strip()}"
        cache_row_id = metadata.get("cache_row_id")
        if marker in actions:
            if not cache_row_id:
                return None
            row = session.get(GlobalQACache, int(cache_row_id))
            return (
                FeedbackQualityResult(
                    float(row.confidence or 0.0), row.status == "rejected"
                )
                if row is not None else None
            )
        actions.append(marker)
        metadata["cache_correction_actions"] = actions[-12:]
        message.metadata_json = json.dumps(
            metadata, sort_keys=True, separators=(",", ":")
        )
        session.add(message)
        if not cache_row_id:
            if commit:
                session.commit()
            return None
        row = session.get(GlobalQACache, int(cache_row_id))
        if row is None:
            if commit:
                session.commit()
            return None
        return self.apply_negative_feedback(
            session, row, amount=amount, tombstone_at_zero=False, commit=commit
        )

    def apply_message_positive_once(
        self,
        session: Session,
        message: WebChatMessage,
        *,
        action: str,
        amount: float = 0.10,
        commit: bool = True,
    ) -> FeedbackQualityResult | None:
        try:
            metadata = json.loads(message.metadata_json or "{}")
        except (TypeError, ValueError):
            metadata = {}
        metadata = metadata if isinstance(metadata, dict) else {}
        actions = [
            str(value) for value in metadata.get("cache_correction_actions", [])
            if str(value)
        ] if isinstance(metadata.get("cache_correction_actions", []), list) else []
        marker = f"positive:{str(action or '').strip()}"
        cache_row_id = metadata.get("cache_row_id")
        if marker in actions:
            if not cache_row_id:
                return None
            row = session.get(GlobalQACache, int(cache_row_id))
            return (
                FeedbackQualityResult(
                    float(row.confidence or 0.0), row.status == "rejected"
                )
                if row is not None else None
            )
        actions.append(marker)
        metadata["cache_correction_actions"] = actions[-12:]
        message.metadata_json = json.dumps(
            metadata, sort_keys=True, separators=(",", ":")
        )
        session.add(message)
        if not cache_row_id:
            if commit:
                session.commit()
            return None
        row = session.get(GlobalQACache, int(cache_row_id))
        if row is None or row.status != "approved":
            if commit:
                session.commit()
            return None
        row.confidence = min(
            self.confidence_maximum(),
            float(row.confidence or 0.0) + max(0.0, amount),
        )
        row.updated_at = utc_now()
        session.add(row)
        if commit:
            session.commit()
        return FeedbackQualityResult(row.confidence, False)
