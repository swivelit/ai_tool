from __future__ import annotations

from dataclasses import dataclass
from typing import List

from sqlmodel import Session


@dataclass(frozen=True)
class AggregatorReflectionResult:
    ok: bool
    clustered: int = 0
    contradictions: int = 0
    reason: str = "stub"


class AggregatorReflectionAgent:
    """Batch-only maintenance stub for future global-cache clustering."""

    request_path_safe = False

    def run_batch(self, _session: Session, row_ids: List[int] | None = None) -> AggregatorReflectionResult:
        return AggregatorReflectionResult(ok=True, clustered=len(row_ids or []), contradictions=0)
