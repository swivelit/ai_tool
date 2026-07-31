from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


AnswerCheckStatus = Literal["not_run", "passed", "failed", "skipped", "error"]
QualityOutcome = Literal[
    "verified",
    "grounded",
    "best_effort",
    "unverified",
    "insufficient_evidence",
]
QualityCheckStatus = Literal["passed", "failed", "warning", "skipped", "error"]


@dataclass(frozen=True)
class QualityCheck:
    check_type: str
    status: QualityCheckStatus
    reason_code: str = ""

    def __post_init__(self) -> None:
        if not self.check_type or len(self.check_type) > 64:
            raise ValueError("check_type must be bounded")
        if len(self.reason_code) > 80:
            raise ValueError("reason_code must be bounded")

    @property
    def safe_summary(self) -> dict[str, str]:
        return {"type": self.check_type, "status": self.status}


@dataclass(frozen=True)
class AnswerQualityResult:
    status: QualityOutcome
    checks: tuple[QualityCheck, ...]
    retrieval_status: str = ""
    repair_attempted: bool = False
    verifier_used: bool = False

    @property
    def passed(self) -> bool:
        return self.status in {"verified", "grounded", "best_effort"}

    @property
    def failed_checks(self) -> tuple[QualityCheck, ...]:
        return tuple(check for check in self.checks if check.status in {"failed", "error"})

    @property
    def safe_summary(self) -> dict[str, object]:
        return {
            "status": self.status,
            "retrieval_status": self.retrieval_status or None,
            "checks": [check.safe_summary for check in self.checks],
        }


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
