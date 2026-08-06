from __future__ import annotations

from dataclasses import dataclass
import re
from collections.abc import Callable

from ...ai.completion_quality import incomplete_markdown_reason
from ..evidence.models import EvidencePack
from .claim_verifier import (
    citation_ids,
    deterministic_evidence_support,
    factual_sections,
    optional_model_claim_check,
)
from .models import (
    AnswerQualityResult, QualityCheck, RepositoryValidationMode,
)
from .output_contract import OutputContract, validate_output_contract
from .output_format import fenced_code_quality_check
from .repository_grounding import repository_path_grounding_check
from .task_requirements import (
    TaskRequirementContract, validate_task_requirements,
)
from .quality_gate import build_quality_result
from ..code_quality.result_parser import RepositoryValidationResult


_HEADING = re.compile(r"^\s*#{1,6}\s+(.+?)\s*$", re.MULTILINE)
_REPOSITORY_CHANGE = re.compile(
    r"\b(commit|patch|modify|edit|change|implement|fix|refactor)\b.{0,60}"
    r"\b(repository|repo|codebase|file|files)\b",
    re.IGNORECASE | re.DOTALL,
)
ANSWER_GUARD_VERSION = "2026-08-02.1"


@dataclass(frozen=True)
class ProviderCompletion:
    """Content-free terminal metadata supplied by a generation provider."""

    finish_reason: str = "unknown"
    completion_status: str = "unknown"
    incomplete_reason: str = ""
    truncated: bool = False

    @classmethod
    def from_raw(cls, value: object) -> "ProviderCompletion":
        raw = value if isinstance(value, dict) else {}
        return cls(
            finish_reason=str(raw.get("finish_reason") or "unknown")[:40],
            completion_status=str(
                raw.get("completion_status") or "unknown"
            )[:40],
            incomplete_reason=str(raw.get("incomplete_reason") or "")[:80],
            truncated=raw.get("truncated") is True,
        )

    @property
    def incomplete(self) -> bool:
        return bool(
            self.truncated
            or self.finish_reason.casefold() == "length"
            or self.completion_status.casefold() == "incomplete"
            or self.incomplete_reason.strip()
        )


@dataclass(frozen=True)
class AnswerGuardContext:
    answer_class: str
    task_contract: str
    evidence_pack: EvidencePack | None = None
    verified_buffered: bool = False
    model_verifier_allowed: bool = False
    repository_validation: RepositoryValidationResult | None = None
    repository_change_required: bool | None = None
    repository_context_used: bool = False
    repository_validation_mode: RepositoryValidationMode | None = None
    repository_file_paths: tuple[str, ...] = ()
    repository_source_files: tuple[tuple[str, str], ...] = ()
    repository_index_complete: bool = True
    output_contract: OutputContract | None = None
    task_requirements: TaskRequirementContract | None = None
    provider_completion: ProviderCompletion | None = None

    @property
    def repository_validation_required(self) -> bool:
        if self.repository_change_required is not None:
            return self.repository_change_required
        return bool(_REPOSITORY_CHANGE.search(self.task_contract))


class AnswerGuard:
    """Deterministic cheapest-first verification for one generated draft."""

    def check(
        self,
        answer: str,
        context: AnswerGuardContext,
        *,
        model_verifier: Callable[[str, EvidencePack], bool] | None = None,
        only_checks: set[str] | None = None,
        repair_attempted: bool = False,
    ) -> AnswerQualityResult:
        requested = only_checks
        checks: list[QualityCheck] = []

        def include(name: str) -> bool:
            return requested is None or name in requested or name in {
                "structural", "empty_answer", "task_completeness"
            }

        structural_reason = incomplete_markdown_reason(answer, context.answer_class)
        if include("structural"):
            checks.append(QualityCheck(
                "structural",
                "failed" if structural_reason else "passed",
                structural_reason,
            ))
        empty = not str(answer or "").strip()
        if include("empty_answer"):
            checks.append(QualityCheck(
                "empty_answer", "failed" if empty else "passed",
                "empty_answer" if empty else "",
            ))
        if include("repetition"):
            checks.append(_repetition_check(answer))
        if include("duplicate_sections"):
            checks.append(_duplicate_section_check(answer))
        if include("output_fenced_code_present"):
            checks.append(fenced_code_quality_check(answer))

        evidence = context.evidence_pack
        evidence_backed = evidence is not None
        if evidence is not None:
            if include("citation_validity"):
                checks.append(_citation_validity(answer, evidence))
            if include("citation_coverage"):
                checks.append(_citation_coverage(answer))
            if include("evidence_support"):
                checks.append(deterministic_evidence_support(answer, evidence))
            if include("contradiction_warning"):
                checks.append(QualityCheck(
                    "contradiction_warning",
                    "warning"
                    if evidence.retrieval_status == "contradictory"
                    or evidence.contradictions
                    else "passed",
                    "contradictory_evidence"
                    if evidence.retrieval_status == "contradictory"
                    or evidence.contradictions
                    else "",
                ))
            if include("model_claim_verifier"):
                checks.append(
                    optional_model_claim_check(
                        answer=answer,
                        evidence_pack=evidence,
                        verifier=(
                            model_verifier
                            if context.model_verifier_allowed else None
                        ),
                    )
                )
        if include("task_completeness"):
            checks.append(_task_completeness(answer, context.task_contract))
        if context.provider_completion is not None:
            checks.append(QualityCheck(
                "provider_completion",
                "failed" if context.provider_completion.incomplete else "passed",
                "provider_output_incomplete"
                if context.provider_completion.incomplete else "",
            ))
        if context.output_contract and context.output_contract.required:
            checks.extend(validate_output_contract(answer, context.output_contract))
        if context.task_requirements and context.task_requirements.required:
            checks.extend(
                check for check in validate_task_requirements(
                    answer, context.task_requirements,
                    repository_source_files=context.repository_source_files,
                ) if include(check.check_type)
            )
        if context.repository_context_used:
            checks.append(QualityCheck(
                "repository_context", "passed", ""
            ))
            if include("repository_path_grounding"):
                checks.append(repository_path_grounding_check(
                    answer, context.repository_file_paths,
                    index_complete=context.repository_index_complete,
                    user_message=context.task_contract,
                ))
        if context.repository_validation_required:
            validation = context.repository_validation
            if validation is None:
                checks.append(QualityCheck(
                    "repository_validation",
                    "skipped",
                    "validator_unavailable",
                ))
            else:
                checks.extend(
                    QualityCheck(
                        f"repository_{item.category}",
                        item.status if item.status != "unavailable" else "skipped",
                        item.safe_code,
                    )
                    for item in validation.checks
                )
                checks.append(QualityCheck(
                    "repository_validation",
                    "passed" if validation.all_required_passed else "failed",
                    "" if validation.all_required_passed else (
                        "required_repository_checks_not_passed"
                    ),
                ))
        return build_quality_result(
            checks=tuple(checks),
            evidence_backed=evidence_backed,
            verified_buffered=context.verified_buffered,
            repository_validation_required=context.repository_validation_required,
            repository_validation_passed=bool(
                context.repository_validation
                and context.repository_validation.all_required_passed
            ),
            retrieval_status=evidence.retrieval_status if evidence else "",
            insufficient_evidence=bool(
                evidence and evidence.retrieval_status == "insufficient"
            ),
            repair_attempted=repair_attempted,
            verifier_used=bool(
                evidence and context.model_verifier_allowed and model_verifier
            ),
            repository_validation_mode=_repository_validation_mode(context),
        )


def _repository_validation_mode(
    context: AnswerGuardContext,
) -> RepositoryValidationMode | None:
    validation = context.repository_validation
    if validation is None:
        return context.repository_validation_mode
    if validation.isolation_level == "executable":
        return "executable"
    if validation.isolation_level == "static_only":
        return "static_only"
    return "unavailable"


def _repetition_check(answer: str) -> QualityCheck:
    without_headings = _HEADING.sub("", str(answer or ""))
    sentences = [
        " ".join(part.lower().split())
        for part in re.split(r"(?<=[.!?])\s+", without_headings)
        if len(part.split()) >= 5
    ]
    repeated = len(sentences) - len(set(sentences))
    excessive = repeated >= 2 or (
        len(sentences) >= 4 and len(set(sentences)) / len(sentences) < 0.65
    )
    return QualityCheck(
        "repetition", "failed" if excessive else "passed",
        "excessive_repetition" if excessive else "",
    )


def _duplicate_section_check(answer: str) -> QualityCheck:
    headings = [" ".join(value.lower().split()) for value in _HEADING.findall(answer)]
    duplicate = len(headings) != len(set(headings))
    return QualityCheck(
        "duplicate_sections", "failed" if duplicate else "passed",
        "duplicate_section_heading" if duplicate else "",
    )


def _citation_validity(answer: str, evidence: EvidencePack) -> QualityCheck:
    allowed = {item.citation_label for item in evidence.items}
    invented = sorted(set(citation_ids(answer)) - allowed)
    return QualityCheck(
        "citation_validity", "failed" if invented else "passed",
        "invented_citation_id" if invented else "",
    )


def _citation_coverage(answer: str) -> QualityCheck:
    missing = [
        section for section in factual_sections(answer)
        if not citation_ids(section)
    ]
    return QualityCheck(
        "citation_coverage", "failed" if missing else "passed",
        "uncited_factual_section" if missing else "",
    )


def _task_completeness(answer: str, task_contract: str) -> QualityCheck:
    value = str(answer or "").strip()
    incomplete = bool(
        re.search(r"\b(?:TODO|TBD|continued below|rest omitted)\b", value, re.I)
        or value.endswith(("…", "...", ":", "-", "•"))
    )
    return QualityCheck(
        "task_completeness", "failed" if incomplete else "passed",
        "incomplete_task" if incomplete else "",
    )
