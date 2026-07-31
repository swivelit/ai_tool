from __future__ import annotations

from .models import AnswerQualityResult, QualityCheck, QualityOutcome


def quality_outcome(
    *,
    checks: tuple[QualityCheck, ...],
    evidence_backed: bool,
    verified_buffered: bool,
    repository_validation_required: bool,
    repository_validation_passed: bool = False,
    insufficient_evidence: bool = False,
) -> QualityOutcome:
    if insufficient_evidence:
        return "insufficient_evidence"
    if any(check.status in {"failed", "error"} for check in checks):
        return "unverified"
    if repository_validation_required and not repository_validation_passed:
        return "unverified"
    if repository_validation_required and repository_validation_passed:
        return "verified"
    if evidence_backed:
        return "grounded"
    if verified_buffered:
        return "verified"
    return "best_effort"


def build_quality_result(
    *,
    checks: tuple[QualityCheck, ...],
    evidence_backed: bool,
    verified_buffered: bool,
    repository_validation_required: bool,
    repository_validation_passed: bool = False,
    retrieval_status: str = "",
    insufficient_evidence: bool = False,
    repair_attempted: bool = False,
    verifier_used: bool = False,
) -> AnswerQualityResult:
    return AnswerQualityResult(
        status=quality_outcome(
            checks=checks,
            evidence_backed=evidence_backed,
            verified_buffered=verified_buffered,
            repository_validation_required=repository_validation_required,
            repository_validation_passed=repository_validation_passed,
            insufficient_evidence=insufficient_evidence,
        ),
        checks=checks,
        retrieval_status=retrieval_status,
        repair_attempted=repair_attempted,
        verifier_used=verifier_used,
    )
