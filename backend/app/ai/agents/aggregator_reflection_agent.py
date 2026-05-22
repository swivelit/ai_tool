from __future__ import annotations

import json
from dataclasses import dataclass
from typing import List

from sqlmodel import Session, select

from ...models import GlobalQACache


@dataclass(frozen=True)
class AggregatorReflectionResult:
    ok: bool
    clustered: int = 0
    contradictions: int = 0
    planned_updates: List[dict] | None = None
    reason: str = "stub"


class AggregatorReflectionAgent:
    """Batch-only maintenance stub for future global-cache clustering."""

    request_path_safe = False

    def run_batch(
        self,
        session: Session,
        row_ids: List[int] | None = None,
        *,
        apply_changes: bool = False,
    ) -> AggregatorReflectionResult:
        query = select(GlobalQACache).where(GlobalQACache.status == "approved")
        if row_ids:
            query = query.where(GlobalQACache.id.in_([int(row_id) for row_id in row_ids]))  # type: ignore[attr-defined]
        rows = list(session.exec(query).all())
        groups: dict[str, list[GlobalQACache]] = {}
        for row in rows:
            key = str(row.answer_hash or row.normalized_question or "").strip()
            if not key:
                continue
            groups.setdefault(key, []).append(row)
        planned_updates: List[dict] = []
        contradictions = 0
        for grouped in groups.values():
            if len(grouped) < 2:
                continue
            grouped = sorted(grouped, key=lambda row: int(row.hit_count or 0), reverse=True)
            keeper = grouped[0]
            duplicates = grouped[1:]
            planned_updates.append(
                {
                    "keeper_id": keeper.id,
                    "duplicate_ids": [row.id for row in duplicates],
                    "answer_hash": keeper.answer_hash,
                }
            )
            if apply_changes:
                notes = json.dumps({"clustered_into": keeper.id}, ensure_ascii=False)
                for duplicate in duplicates:
                    duplicate.review_notes = ((duplicate.review_notes or "") + "\n" + notes).strip()
                    session.add(duplicate)
        if apply_changes and planned_updates:
            session.commit()
        return AggregatorReflectionResult(
            ok=True,
            clustered=sum(len(update["duplicate_ids"]) for update in planned_updates),
            contradictions=contradictions,
            planned_updates=planned_updates,
            reason="planned" if not apply_changes else "applied",
        )


def run_global_qa_aggregation_job(
    session: Session,
    row_ids: List[int] | None = None,
    *,
    apply_changes: bool = False,
) -> AggregatorReflectionResult:
    return AggregatorReflectionAgent().run_batch(session, row_ids=row_ids, apply_changes=apply_changes)
