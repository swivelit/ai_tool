from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


AnswerCheckStatus = Literal["not_run", "passed", "failed", "skipped", "error"]


@dataclass(frozen=True)
class AnswerCheckResult:
    status: AnswerCheckStatus
    passed: bool
    reason_codes: tuple[str, ...] = ()
    supported_claim_count: int = 0
    unsupported_claim_count: int = 0
    citation_count: int = 0
    retry_recommended: bool = False

    def __post_init__(self) -> None:
        if min(
            self.supported_claim_count,
            self.unsupported_claim_count,
            self.citation_count,
        ) < 0:
            raise ValueError("answer-check counts must be non-negative")
        if self.status == "passed" and not self.passed:
            raise ValueError("passed status requires passed=True")
        if self.status == "failed" and self.passed:
            raise ValueError("failed status requires passed=False")
