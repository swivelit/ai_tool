from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import hashlib
import json
import re
from typing import Any

from .models import QualityCheck


TASK_REQUIREMENT_VERSION = "2026-08-03.6"
_NUMBERED = re.compile(r"(?m)^\s*(\d{1,2})[.)]\s+(.{3,240}?)\s*$")
_ANSWER_NUMBERED = re.compile(
    r"(?m)^\s{0,3}(?:#{1,6}\s+)?(?:\*\*)?(\d{1,2})[.)]\s+"
    r"(?:\*\*)?(.+?)(?:\*\*)?\s*$"
)
_WORD = re.compile(r"[A-Za-z0-9_+-]+", re.UNICODE)
_STOP = {
    "a", "an", "and", "are", "be", "for", "in", "include", "of", "on",
    "or", "the", "to", "using", "with", "must", "should", "handling",
}

@dataclass(frozen=True)
class IdempotencySemanticEvaluation:
    definition_present: bool
    concrete_retry_example_present: bool
    stable_outcome_present: bool
    validator_version: str = TASK_REQUIREMENT_VERSION


@dataclass(frozen=True)
class AuthoritySemanticEvaluation:
    authoritative_store_present: bool
    forbidden_authority_passed: bool
    forbidden_authority_violation: bool
    validator_version: str = TASK_REQUIREMENT_VERSION


ARCHITECTURE_AREA_IDENTIFIERS = (
    "database_schema",
    "transaction_boundaries",
    "state_transitions",
    "pseudocode",
    "duplicate_handling",
    "out_of_order_handling",
    "failure_recovery",
    "reconciliation",
    "security_checks",
    "test_plan",
)


@dataclass(frozen=True)
class ArchitectureAreaEvaluation:
    area_identifier: str
    heading_present: bool
    semantic_mechanism_present: bool
    stable_side_effect_outcome_present: bool
    passed: bool
    validator_version: str = TASK_REQUIREMENT_VERSION


@dataclass(frozen=True)
class ArchitectureCoverageEvaluation:
    areas: tuple[ArchitectureAreaEvaluation, ...]
    validator_version: str = TASK_REQUIREMENT_VERSION

    @property
    def covered_area_identifiers(self) -> tuple[str, ...]:
        return tuple(item.area_identifier for item in self.areas if item.passed)

    @property
    def missing_area_identifiers(self) -> tuple[str, ...]:
        return tuple(
            item.area_identifier for item in self.areas if not item.passed
        )


def normalize_architecture_semantics(value: str) -> str:
    normalized = str(value or "").casefold()
    normalized = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", normalized)
    normalized = normalized.replace("**", " ").replace("__", " ")
    normalized = normalized.replace("`", " ")
    normalized = re.sub(r"[-\u2010-\u2015\u2212_]", " ", normalized)
    return " ".join(normalized.split())


def _architecture_area_from_label(label: str) -> str | None:
    value = normalize_architecture_semantics(label)
    rules = (
        ("database_schema", (
            r"\bdatabase\b.*\b(?:table|schema)",
            r"\b(?:tables?|schema)\b.*\b(?:unique|constraint)",
        )),
        ("transaction_boundaries", (r"\btransaction\b.*\bboundar",)),
        ("state_transitions", (r"\b(?:event|payment|state)\b.*\btransition",)),
        ("pseudocode", (r"\bpseudocode\b",)),
        ("duplicate_handling", (r"\bduplicate\b.*\bhandling\b",)),
        ("out_of_order_handling", (r"\bout of order\b.*\bhandling\b",)),
        ("failure_recovery", (r"\bfailure\b.*\brecovery\b",)),
        ("reconciliation", (r"\breconcil",)),
        ("security_checks", (r"\bsecurity\b.*\bchecks?\b",)),
        ("test_plan", (r"\btest\b.*\bplan\b",)),
    )
    for area_identifier, patterns in rules:
        if any(re.search(pattern, value) for pattern in patterns):
            return area_identifier
    return None


def architecture_area_ids_for_contract(
    contract: "TaskRequirementContract",
) -> tuple[str, ...]:
    identifiers = tuple(
        _architecture_area_from_label(item.label)
        for item in contract.deliverables
    )
    if (
        len(identifiers) == len(ARCHITECTURE_AREA_IDENTIFIERS)
        and identifiers == ARCHITECTURE_AREA_IDENTIFIERS
    ):
        return ARCHITECTURE_AREA_IDENTIFIERS
    return ()


@dataclass(frozen=True)
class _ArchitectureSection:
    normalized_value: str
    raw_value: str


@dataclass(frozen=True)
class ArchitectureSectionSpan:
    area_identifier: str
    ordinal: int
    label: str
    start: int
    heading_end: int
    end: int


def architecture_section_spans(
    answer: str,
) -> tuple[ArchitectureSectionSpan, ...]:
    value = str(answer or "")
    fenced_ranges = tuple(
        (match.start(), match.end())
        for match in re.finditer(r"```.*?```", value, re.DOTALL)
    )
    candidates = [
        match for match in _ANSWER_NUMBERED.finditer(value)
        if not any(start <= match.start() < end for start, end in fenced_ranges)
    ]
    accepted: list[tuple[str, int, re.Match[str]]] = []
    last_ordinal = 0
    for match in candidates:
        ordinal = int(match.group(1))
        if (
            ordinal <= last_ordinal
            or ordinal > len(ARCHITECTURE_AREA_IDENTIFIERS)
        ):
            continue
        area_identifier = _architecture_area_from_label(match.group(2))
        expected_area = ARCHITECTURE_AREA_IDENTIFIERS[ordinal - 1]
        if area_identifier != expected_area:
            continue
        accepted.append((expected_area, ordinal, match))
        last_ordinal = ordinal
    return tuple(
        ArchitectureSectionSpan(
            area_identifier=area_identifier,
            ordinal=ordinal,
            label=match.group(2),
            start=match.start(),
            heading_end=match.end(),
            end=(
                accepted[index + 1][2].start()
                if index + 1 < len(accepted) else len(value)
            ),
        )
        for index, (area_identifier, ordinal, match) in enumerate(accepted)
    )


def _architecture_sections(
    answer: str,
) -> tuple[dict[str, _ArchitectureSection], str, str]:
    value = str(answer or "")
    spans = architecture_section_spans(value)

    sections: dict[str, _ArchitectureSection] = {}
    for span in spans:
        label_parts = re.split(
            r"\s+(?:[-\u2010-\u2015\u2212]|:)\s+",
            span.label, maxsplit=1,
        )
        inline_detail = label_parts[1] if len(label_parts) == 2 else ""
        raw_section = inline_detail + "\n" + value[
            span.heading_end:span.end
        ]
        sections[span.area_identifier] = _ArchitectureSection(
            normalized_value=normalize_architecture_semantics(raw_section),
            raw_value=raw_section,
        )

    fallback_parts: list[str] = []
    cursor = 0
    for span in spans:
        fallback_parts.append(value[cursor:span.start])
        fallback_parts.append("\n")
        cursor = span.heading_end
    fallback_parts.append(value[cursor:])
    raw_fallback = "".join(fallback_parts)
    return sections, normalize_architecture_semantics(raw_fallback), raw_fallback


def splice_architecture_section_repair(
    prior_answer: str,
    repair_answer: str,
    expected_area_identifiers: tuple[str, ...],
) -> str | None:
    expected = tuple(dict.fromkeys(expected_area_identifiers))
    if not expected:
        return None
    prior = str(prior_answer or "")
    repair = str(repair_answer or "")
    prior_spans = {
        span.area_identifier: span
        for span in architecture_section_spans(prior)
    }
    repair_spans = architecture_section_spans(repair)
    repair_span_by_area = {
        span.area_identifier: span for span in repair_spans
    }
    # A repair model may add a short preface or repeat otherwise-valid
    # sections despite being told to return only the targets. Those bytes are
    # never spliced. Accept the response whenever every expected section is
    # parseable, and extract only those exact replacements.
    if any(area not in prior_spans for area in expected) or any(
        area not in repair_span_by_area for area in expected
    ):
        return None
    replacements = {
        area_identifier: repair[span.start:span.end].strip()
        for area_identifier in expected
        if (span := repair_span_by_area.get(area_identifier)) is not None
    }
    if any(not replacements.get(area) for area in expected):
        return None
    result = prior
    for area_identifier in sorted(
        expected, key=lambda area: prior_spans[area].start, reverse=True
    ):
        span = prior_spans[area_identifier]
        replacement = replacements[area_identifier]
        if span.end < len(prior) and not replacement.endswith(("\n", "\r")):
            replacement += "\n"
        result = result[:span.start] + replacement + result[span.end:]
    return result


def _architecture_mechanism(
    area_identifier: str,
    value: str,
    raw_value: str,
) -> bool:
    if area_identifier == "database_schema":
        return bool(
            re.search(r"\b(?:tables?|schema|event inbox|webhook events?|payments?|wallet ledger)\b", value)
            and re.search(r"\b(?:unique|primary key|constraint|provider event id)\b", value)
        )
    patterns = {
        "transaction_boundaries": r"\b(?:atomic transaction|begin|commit|rollback|select for update|transaction boundar\w*|same transaction)\b",
        "state_transitions": r"\b(?:state transitions?|state machine|status transitions?|payment lifecycle|event lifecycle|monotonic\w*[^.;]{0,40}transition\w*|transition\w*[^.;]{0,40}monotonic\w*|status rank)\b",
        "pseudocode": r"\b(?:pseudocode|algorithm|processing flow|handler flow|worker flow|process event|begin transaction|def|function|return|commit|insert|select)\b",
        "out_of_order_handling": r"\b(?:out of order|late event|event ordering|reorder|sequence gap|monotonic state|stale|older event|arrives late|ordering|forward only|out of sequence|earlier event\w*|arriv\w*[^.;]{0,40}(?:late|later|after|early)|(?:older|earlier|newer)[^.;]{0,40}(?:event|state|status|update)\w*|superseded|outdated|defer\w*|buffer\w*[^.;]{0,40}event\w*|(?:skip\w*|discard\w*|ignor\w*)[^.;]{0,50}(?:older|earlier|stale|outdated|out of order|out of sequence)|forward transition\w*|only forward|predecessor\w*|gap[^.;]{0,30}(?:close\w*|fill\w*))\b",
        "failure_recovery": r"\b(?:failure recovery|retryable inbox|safe replay|dead letter|crash\w*|lease recovery|re queue|requeue|retry|resume|sweeper|lease|pending events?)\b",
        "reconciliation": r"\b(?:reconciliation|reconcile|audit job|consistency check|provider poll)\b",
        "security_checks": r"\b(?:security checks?|signature verification|hmac|replay attack|replay window|timestamp validation|raw body|(?:verif\w*|validat\w*|authenticat\w*|recomput\w*|check\w*)[^.;]{0,50}(?:signature|hmac|digest|secret)|(?:signature|hmac|digest)[^.;]{0,50}(?:verif\w*|validat\w*|match\w*|mismatch\w*|reject\w*)|webhook secret|shared secret|x razorpay signature|constant time|timestamp[^.;]{0,40}(?:check\w*|validat\w*|reject\w*))\b",
        "test_plan": r"\b(?:test plan|testing strategy|test cases?|concurrency test|failure injection|integration tests?)\b|\b(?:tests?|scenarios?|coverage)\b[^.;]{0,80}\b(?:duplicate|concurren\w*|crash\w*|refund\w*|replay|out of order)\b|\b(?:duplicate|concurren\w*|crash\w*|refund\w*|replay|out of order)\b[^.;]{0,80}\b(?:tests?|scenarios?|coverage)\b",
    }
    if area_identifier == "pseudocode" and re.search(
        r"```[\s\S]*?```", raw_value
    ):
        return True
    if area_identifier == "state_transitions" and re.search(
        r"(?:->|→|=>)", raw_value
    ):
        return True
    return bool(re.search(patterns[area_identifier], value))


def _duplicate_semantics(value: str) -> tuple[bool, bool]:
    mechanism = bool(re.search(
        r"\b(?:deduplicat\w*|dedupe\w*|idempotent|idempotency|already processed|"
        r"unique provider event id|unique event(?: id)? constraint|on conflict|"
        r"(?:ignore|ignored|acknowledge|acknowledged) (?:a )?duplicate|"
        r"stored event result)\b",
        value,
    ))
    stable = bool(re.search(
        r"\bon conflict do nothing\b|"
        r"\b(?:return|returns|acknowledge|acknowledges) (?:http )?(?:200|success)"
        r"[^.;]{0,70}\b(?:already processed|duplicate)\b|"
        r"\b(?:already processed|duplicate)\b[^.;]{0,70}"
        r"\b(?:return|returns|acknowledge|acknowledges) (?:http )?(?:200|success)\b|"
        r"\b(?:no|without|prevent\w*|cannot|does not)\b[^.;]{0,70}"
        r"\b(?:second|another|repeated|duplicate)\b[^.;]{0,35}"
        r"\b(?:wallet credit|ledger credit|ledger mutation|charge|processing|side effect)\b|"
        r"\breuse\w* (?:the )?stored event result\b",
        value,
    ))
    return mechanism, stable


def evaluate_architecture_coverage(
    answer: str,
) -> ArchitectureCoverageEvaluation:
    sections, normalized_fallback, raw_fallback = _architecture_sections(answer)
    areas: list[ArchitectureAreaEvaluation] = []
    for area_identifier in ARCHITECTURE_AREA_IDENTIFIERS:
        section = sections.get(area_identifier)
        heading_present = section is not None
        section_value = section.normalized_value if section else ""
        raw_section_value = section.raw_value if section else ""
        semantic_value = (
            section_value if heading_present else normalized_fallback
        )
        raw_semantic_value = (
            raw_section_value if heading_present else raw_fallback
        )
        if area_identifier == "duplicate_handling":
            mechanism, stable = _duplicate_semantics(semantic_value)
            passed = mechanism or stable
        else:
            mechanism = _architecture_mechanism(
                area_identifier, semantic_value, raw_semantic_value
            )
            stable = False
            passed = mechanism
        areas.append(ArchitectureAreaEvaluation(
            area_identifier=area_identifier,
            heading_present=heading_present,
            semantic_mechanism_present=mechanism,
            stable_side_effect_outcome_present=stable,
            passed=passed,
        ))
    return ArchitectureCoverageEvaluation(tuple(areas))


def evaluate_idempotency_semantics(
    answer: str,
) -> IdempotencySemanticEvaluation:
    value = str(answer or "")
    definition_present = bool(
        re.search(r"\bidempoten\w*\b", value, re.IGNORECASE)
        and re.search(
            r"\b(?:payment|charge|request|operation|endpoint|API)\w*\b",
            value,
            re.IGNORECASE,
        )
        and re.search(
            r"\b(?:means|is|refers to|ensures|allows|prevents|guarantees|"
            r"describes|when)\b",
            value,
            re.IGNORECASE,
        )
    )
    retry_present = bool(re.search(
        r"\b(?:retry|retries|retried|repeated request|request again|sends? "
        r"(?:it|the request) again|second attempt)\b",
        value,
        re.IGNORECASE,
    ))
    concrete_marker = bool(re.search(
        r"\b(?:GET|POST|PUT|PATCH|DELETE)\b|/[A-Za-z][A-Za-z0-9_/-]*|"
        r"\b(?:after (?:a )?timeout|client|identifier|request id|payment id|"
        r"order id|idempotency key)\b",
        value,
        re.IGNORECASE,
    ))
    stable_outcome_present = bool(re.search(
        r"\b(?:reuse[sd]? (?:the |an? )?(?:same )?(?:identifier|key|id)|"
        r"same (?:identifier|key|id|result|response|outcome)|"
        r"(?:return|receive[sd]?|gets?) (?:the )?(?:stored|previous|original|"
        r"same|first) (?:result|response|outcome)|"
        r"(?:without|no|prevent(?:s|ing)?|avoid(?:s|ing)?) (?:a |the )?"
        r"(?:second|additional|duplicate) (?:charge|payment|processing|operation)|"
        r"(?:one|single) (?:charge|payment|operation|result|outcome)|"
        r"already processed|does not (?:charge|process|create) (?:it )?again|"
        r"instead of duplicate processing|prevents? duplicate (?:work|processing|"
        r"charges?|payments?))\b",
        value,
        re.IGNORECASE,
    ))
    return IdempotencySemanticEvaluation(
        definition_present=definition_present,
        concrete_retry_example_present=retry_present and concrete_marker,
        stable_outcome_present=stable_outcome_present,
    )


def _authority_clauses(value: str) -> tuple[str, ...]:
    return tuple(
        clause.strip()
        for clause in re.split(r"(?<=[.!?;])\s+|\n+", str(value or ""))
        if clause.strip()
    )


def _safe_forbidden_authority_clause(clause: str, store: str) -> bool:
    if not re.search(rf"\b{re.escape(store)}\b", clause, re.IGNORECASE):
        return False
    escaped = re.escape(store)
    return bool(re.search(
        rf"\b{escaped}\b[^.;]{{0,55}}\bnon[- ]authoritative\b|"
        rf"\b{escaped}\b[^.;]{{0,55}}\b(?:not|never|isn't|is not|must not)\b"
        r"[^.;]{0,30}\b(?:authoritative|source of truth|system of record|canonical)\b|"
        rf"\b{escaped}\b[^.;]{{0,55}}\b(?:cache|queue) only\b|"
        rf"\b{escaped}\b[^.;]{{0,55}}\bonly (?:a )?(?:cache|queue)\b|"
        rf"\b{escaped}\b[^.;]{{0,55}}\bdoes not own (?:the )?durable state\b|"
        r"\bneither\s+redis\s+nor\s+valkey\b[^.;]{0,55}"
        r"\b(?:authoritative|source of truth|system of record|canonical)\b",
        clause,
        re.IGNORECASE,
    ))


def _store_has_authority_clause(clause: str, store: str) -> bool:
    escaped = re.escape(store)
    authority_text = (
        r"(?:source of truth|system of record|authoritative(?: store| database)?|"
        r"canonical(?: store| database)?|owns? (?:the )?durable state)"
    )
    return bool(re.search(
        rf"\b{escaped}\b[^.;]{{0,55}}\b{authority_text}\b|"
        rf"\b{authority_text}\b\s+(?:is|remains|:)\s+(?:the\s+)?"
        rf"\b{escaped}\b",
        clause,
        re.IGNORECASE,
    ))


def evaluate_authority_semantics(
    answer: str,
    *,
    authoritative_store: str,
    forbidden_stores: tuple[str, ...],
) -> AuthoritySemanticEvaluation:
    clauses = _authority_clauses(answer)
    authoritative_store_present = any(
        _store_has_authority_clause(clause, authoritative_store)
        and not _safe_forbidden_authority_clause(clause, authoritative_store)
        for clause in clauses
    )
    safe_stores = {
        store for store in forbidden_stores
        if any(_safe_forbidden_authority_clause(clause, store) for clause in clauses)
    }
    violation = any(
        _store_has_authority_clause(clause, store)
        and not _safe_forbidden_authority_clause(clause, store)
        for store in forbidden_stores
        for clause in clauses
    )
    return AuthoritySemanticEvaluation(
        authoritative_store_present=authoritative_store_present,
        forbidden_authority_passed=(
            bool(forbidden_stores)
            and len(safe_stores) == len(set(forbidden_stores))
            and not violation
        ),
        forbidden_authority_violation=violation,
    )


def _terms(value: str, limit: int = 10) -> tuple[str, ...]:
    output: list[str] = []
    for token in _WORD.findall(str(value or "").casefold()):
        if len(token) > 5 and token.endswith("ies"):
            normalized = token[:-3] + "y"
        else:
            normalized = token.rstrip("s") if len(token) > 5 else token
        if len(normalized) < 3 or normalized in _STOP or normalized in output:
            continue
        output.append(normalized)
        if len(output) >= limit:
            break
    return tuple(output)


@dataclass(frozen=True)
class RequiredDeliverable:
    ordinal: int
    label: str
    terms: tuple[str, ...]


@dataclass(frozen=True)
class TaskRequirementContract:
    definition_topics: tuple[str, ...] = ()
    definition_requires_explicit_meaning: bool = False
    concrete_example: bool = False
    concrete_example_terms: tuple[str, ...] = ()
    stable_single_operation_outcome: bool = False
    deliverables: tuple[RequiredDeliverable, ...] = ()
    authoritative_store: str | None = None
    forbidden_authoritative_stores: tuple[str, ...] = ()
    comparison_terms: tuple[str, ...] = ()
    explicit_subquestion_count: int = 0
    transaction_boundary_required: bool = False
    pseudocode_required: bool = False
    contextual_stack_terms: tuple[str, ...] = ()
    contextual_anchor_terms: tuple[str, ...] = ()
    prior_context_reask_forbidden: bool = False
    duplicate_retry_fix_required: bool = False
    repository_unified_diff_required: bool = False
    repository_patch_context_required: bool = False
    repository_validation_command: str | None = None
    repository_validation_claim_mode: str | None = None
    repository_forbidden_stack_assumptions: tuple[str, ...] = ()
    repository_actual_stack_terms: tuple[str, ...] = ()
    repository_missing_path_response_required: bool = False
    version: str = TASK_REQUIREMENT_VERSION

    @property
    def required(self) -> bool:
        return bool(
            self.definition_topics
            or self.concrete_example
            or self.deliverables
            or self.stable_single_operation_outcome
            or self.authoritative_store
            or self.forbidden_authoritative_stores
            or self.comparison_terms
            or self.explicit_subquestion_count
            or self.transaction_boundary_required
            or self.pseudocode_required
            or self.contextual_stack_terms
            or self.contextual_anchor_terms
            or self.prior_context_reask_forbidden
            or self.duplicate_retry_fix_required
            or self.repository_unified_diff_required
            or self.repository_patch_context_required
            or self.repository_validation_command
            or self.repository_validation_claim_mode
            or self.repository_forbidden_stack_assumptions
            or self.repository_actual_stack_terms
            or self.repository_missing_path_response_required
        )

    def as_metadata(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_metadata(cls, value: object) -> "TaskRequirementContract":
        if not isinstance(value, dict):
            return cls()
        deliverables: list[RequiredDeliverable] = []
        raw_deliverables = value.get("deliverables")
        if isinstance(raw_deliverables, (list, tuple)):
            for item in raw_deliverables[:20]:
                if not isinstance(item, dict):
                    continue
                ordinal = item.get("ordinal")
                label = item.get("label")
                terms = item.get("terms")
                if (
                    isinstance(ordinal, int) and 1 <= ordinal <= 20
                    and isinstance(label, str) and label.strip()
                    and isinstance(terms, (list, tuple))
                ):
                    deliverables.append(RequiredDeliverable(
                        ordinal, label.strip()[:240],
                        tuple(str(term)[:40] for term in terms[:10]),
                    ))
        return cls(
            definition_topics=tuple(
                str(item)[:40] for item in (value.get("definition_topics") or ())[:10]
            ) if isinstance(value.get("definition_topics"), (list, tuple)) else (),
            definition_requires_explicit_meaning=(
                value.get("definition_requires_explicit_meaning") is True
            ),
            concrete_example=value.get("concrete_example") is True,
            concrete_example_terms=tuple(
                str(item)[:40] for item in (value.get("concrete_example_terms") or ())[:10]
            ) if isinstance(value.get("concrete_example_terms"), (list, tuple)) else (),
            stable_single_operation_outcome=(
                value.get("stable_single_operation_outcome") is True
            ),
            deliverables=tuple(deliverables),
            authoritative_store=(
                str(value.get("authoritative_store"))[:40]
                if isinstance(value.get("authoritative_store"), str)
                and str(value.get("authoritative_store")).strip()
                else None
            ),
            forbidden_authoritative_stores=tuple(
                str(item)[:40]
                for item in (value.get("forbidden_authoritative_stores") or ())[:8]
            ) if isinstance(
                value.get("forbidden_authoritative_stores"), (list, tuple)
            ) else (),
            comparison_terms=tuple(
                str(item)[:40] for item in (value.get("comparison_terms") or ())[:12]
            ) if isinstance(value.get("comparison_terms"), (list, tuple)) else (),
            explicit_subquestion_count=(
                int(value.get("explicit_subquestion_count") or 0)
                if isinstance(value.get("explicit_subquestion_count"), int) else 0
            ),
            transaction_boundary_required=(
                value.get("transaction_boundary_required") is True
            ),
            pseudocode_required=value.get("pseudocode_required") is True,
            contextual_stack_terms=tuple(
                str(item)[:40]
                for item in (value.get("contextual_stack_terms") or ())[:8]
            ) if isinstance(
                value.get("contextual_stack_terms"), (list, tuple)
            ) else (),
            contextual_anchor_terms=tuple(
                str(item)[:40]
                for item in (value.get("contextual_anchor_terms") or ())[:12]
            ) if isinstance(
                value.get("contextual_anchor_terms"), (list, tuple)
            ) else (),
            prior_context_reask_forbidden=(
                value.get("prior_context_reask_forbidden") is True
            ),
            duplicate_retry_fix_required=(
                value.get("duplicate_retry_fix_required") is True
            ),
            repository_unified_diff_required=(
                value.get("repository_unified_diff_required") is True
            ),
            repository_patch_context_required=(
                value.get("repository_patch_context_required") is True
            ),
            repository_validation_command=(
                str(value.get("repository_validation_command"))[:120]
                if isinstance(value.get("repository_validation_command"), str)
                and str(value.get("repository_validation_command")).strip()
                else None
            ),
            repository_validation_claim_mode=(
                str(value.get("repository_validation_claim_mode"))[:32]
                if value.get("repository_validation_claim_mode")
                in {"static_only", "executable", "unavailable"}
                else None
            ),
            repository_forbidden_stack_assumptions=tuple(
                str(item)[:40]
                for item in (
                    value.get("repository_forbidden_stack_assumptions") or ()
                )[:8]
            ) if isinstance(
                value.get("repository_forbidden_stack_assumptions"),
                (list, tuple),
            ) else (),
            repository_actual_stack_terms=tuple(
                str(item)[:40]
                for item in (value.get("repository_actual_stack_terms") or ())[:12]
            ) if isinstance(
                value.get("repository_actual_stack_terms"), (list, tuple)
            ) else (),
            repository_missing_path_response_required=(
                value.get("repository_missing_path_response_required") is True
            ),
            version=str(value.get("version") or TASK_REQUIREMENT_VERSION)[:32],
        )

    @property
    def hash(self) -> str:
        payload = json.dumps(
            self.as_metadata(), sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def prompt_instruction(self, max_output_tokens: int) -> str:
        if not self.required:
            return ""
        rules: list[str] = []
        if self.definition_topics:
            rules.append(
                "Explicitly define or explain: " + " ".join(self.definition_topics) + "."
            )
        if self.concrete_example:
            rules.append(
                "Include one concrete, specific example"
                + (" involving " + " ".join(self.concrete_example_terms)
                   if self.concrete_example_terms else "") + "."
            )
        if self.stable_single_operation_outcome:
            rules.append(
                "The concrete retry example must preserve one logical operation: "
                "reuse an identifier, return the stored/original result, or prevent "
                "a second charge or duplicate processing."
            )
        if self.authoritative_store and self.forbidden_authoritative_stores:
            rules.append(
                f"Use one dedicated sentence stating that "
                f"{self.authoritative_store} is the system of record."
            )
            rules.append(
                "Use a separate dedicated sentence explicitly naming every "
                "non-authoritative store: "
                + ", ".join(self.forbidden_authoritative_stores) + "."
            )
        else:
            if self.authoritative_store:
                rules.append(
                    f"State explicitly that {self.authoritative_store} is the "
                    "authoritative source of truth or system of record."
                )
            if self.forbidden_authoritative_stores:
                rules.append(
                    "State explicitly that these stores are non-authoritative and "
                    "do not own canonical durable state: "
                    + ", ".join(self.forbidden_authoritative_stores) + "."
                )
        if self.comparison_terms:
            rules.append(
                "Explicitly compare all named alternatives: "
                + ", ".join(self.comparison_terms) + "."
            )
        if self.explicit_subquestion_count:
            rules.append(
                f"Answer all {self.explicit_subquestion_count} explicit sub-questions."
            )
        if self.transaction_boundary_required:
            rules.append(
                "Show the requested transaction boundary explicitly, including "
                "where the transaction begins and commits or rolls back."
            )
        if self.pseudocode_required:
            rules.append(
                "Include concrete pseudocode with executable-style control flow, "
                "not only a prose description."
            )
        if self.contextual_stack_terms:
            rules.append(
                "Use the edited/current prior-turn stack without substituting an "
                "older branch. Explicitly retain: "
                + ", ".join(self.contextual_stack_terms) + "."
            )
        if self.contextual_anchor_terms:
            rules.append(
                "Ground the answer in the prior-turn problem and explicitly name "
                "at least one relevant context anchor: "
                + ", ".join(self.contextual_anchor_terms) + "."
            )
        if self.prior_context_reask_forbidden:
            rules.append(
                "Use the attached same-thread turns as available context. Do not "
                "ask the user to repeat the system, stack, or problem details "
                "already supplied there."
            )
        if self.duplicate_retry_fix_required:
            rules.append(
                "Identify the duplicate/retry idempotency failure mode, state the "
                "first concrete uniqueness or idempotency-key change, and explain "
                "that the reservation and deduplication record commit atomically "
                "in one transaction."
            )
        if self.repository_unified_diff_required:
            rules.append(
                "Return a syntactically intact unified diff. Emit a `diff --git "
                "a/<path> b/<path>` header for every changed file, followed by "
                "that file's `---` and `+++` headers and at least one `@@` hunk; "
                "do not replace the diff with prose or partial snippets. Copy "
                "every context and removed line verbatim from the authoritative "
                "line-numbered source supplied with this request; never "
                "reconstruct source context from memory."
            )
        if self.repository_validation_command:
            rules.append(
                "Name the repository-defined validation command exactly as "
                f"`{self.repository_validation_command}`."
            )
        if self.repository_validation_claim_mode == "static_only":
            rules.append(
                "Validation is static-only for this answer. State honestly that "
                "repository tests were not executed; do not claim that tests, "
                "lint, build, or type checks ran or passed."
            )
        elif self.repository_validation_claim_mode == "unavailable":
            rules.append(
                "Executable validation is unavailable for this answer. Do not "
                "claim that repository checks ran or passed."
            )
        if self.repository_forbidden_stack_assumptions:
            rules.append(
                "Identify the repository's actual stack and explicitly reject "
                "these unsupported framework assumptions: "
                + ", ".join(self.repository_forbidden_stack_assumptions) + "."
            )
            if self.repository_actual_stack_terms:
                rules.append(
                    "Name the actual indexed stack using at least one of: "
                    + ", ".join(self.repository_actual_stack_terms) + "."
                )
        if self.repository_missing_path_response_required:
            rules.append(
                "The requested file is absent from the complete index. Say it "
                "was not found and do not invent its behavior, contents, or importers."
            )
        if self.deliverables:
            target = max(35, min(
                120,
                int(max(1, max_output_tokens) * 0.70 / len(self.deliverables)),
            ))
            rules.append(
                f"Cover all {len(self.deliverables)} required deliverables before optional detail. "
                f"Use concise numbered headings in the given order and target at most {target} "
                "visible words per section. Do not repeat background across sections."
            )
            rules.extend(
                f"{item.ordinal}. {item.label}" for item in self.deliverables
            )
        if architecture_area_ids_for_contract(self):
            rules.append(
                "For every architecture area, provide concrete behavior rather "
                "than a heading alone. For duplicate handling, name a durable "
                "deduplication or idempotency mechanism, or a stable no-repeat "
                "outcome such as no second wallet credit or ledger mutation."
            )
        return "Mandatory task requirements; all are verified:\n- " + "\n- ".join(rules)


def extract_task_requirements(message: str) -> TaskRequirementContract:
    text = str(message or "")
    definition_topics: tuple[str, ...] = ()
    definition_requires_explicit_meaning = False
    definition = re.search(
        r"\b(?P<verb>define|explain)\s+(.{2,100}?)(?:\s+to\s+|\s+for\s+|\s+from\s+|[.?!\n]|$)",
        text, re.IGNORECASE,
    )
    if definition:
        definition_topics = _terms(definition.group(2), 8)
        definition_requires_explicit_meaning = bool(
            definition.group("verb").casefold() == "define"
            or re.search(
                r"\bexplain\b.{0,100}\bto\s+(?:a|an|the)\b",
                text, re.IGNORECASE,
            )
        )

    example = re.search(
        r"\b(?:include|give|provide|show|use)\s+(?:one|a|an|\d+)?\s*"
        r"(?:concrete|specific|practical|worked)?\s*"
        r"(?P<example_kind>[a-z][a-z-]{1,24})?\s*example\b",
        text, re.IGNORECASE,
    )
    example_terms: tuple[str, ...] = ()
    if example:
        example_terms = _terms(str(example.group("example_kind") or ""), 5)
        if not example_terms:
            example_terms = _terms(text[example.end():example.end() + 80], 5)
        if not example_terms:
            example_terms = _terms(text[max(0, example.start() - 60):example.start()], 5)

    stable_single_operation_outcome = bool(
        re.search(r"\bidempoten\w*\b", text, re.IGNORECASE)
        and re.search(r"\bretry\b", text, re.IGNORECASE)
        and example is not None
    )

    deliverables = tuple(
        RequiredDeliverable(int(number), label.strip()[:240], _terms(label))
        for number, label in _NUMBERED.findall(text)[:20]
    )

    authoritative_store = None
    authority_match = re.search(
        r"(?m)^\s*[-*+]?\s*([A-Za-z][A-Za-z0-9_-]{1,39})\s+is\s+"
        r"(?:the\s+)?(?:source of truth|system of record|authoritative)",
        text,
        re.IGNORECASE,
    )
    if authority_match:
        authoritative_store = authority_match.group(1)
    forbidden_authoritative_stores: tuple[str, ...] = ()
    forbidden_match = re.search(
        r"(?m)^\s*[-*+]?\s*([A-Za-z][A-Za-z0-9_-]{1,39})\s+or\s+"
        r"([A-Za-z][A-Za-z0-9_-]{1,39})\s+must\s+not\s+be\s+"
        r"(?:the\s+)?(?:source of truth|system of record|authoritative)",
        text,
        re.IGNORECASE,
    )
    if forbidden_match:
        forbidden_authoritative_stores = (
            forbidden_match.group(1), forbidden_match.group(2),
        )

    comparison_terms: tuple[str, ...] = ()
    comparison = re.search(
        r"\bcompare\s+(.{2,80}?)\s+(?:with|versus|vs\.?|and)\s+"
        r"(.{2,80}?)(?:[.?!\n]|$)",
        text, re.IGNORECASE,
    )
    if comparison:
        right_side = re.split(
            r"\s+and\s+(?:explain|describe|identify|state|answer|include)\b",
            comparison.group(2),
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0]
        comparison_terms = _terms(
            comparison.group(1) + " " + right_side, 12
        )

    explicit_subquestions = len(re.findall(r"(?m)^\s*(?:\d+[.)]|[-*+])\s+[^\n?]+\?\s*$", text))
    transaction_boundary_required = bool(re.search(
        r"\b(?:show|include|provide|define|describe)\b[^.?!\n]{0,80}"
        r"\btransaction\s+boundar(?:y|ies)\b",
        text, re.IGNORECASE,
    ))
    pseudocode_required = bool(re.search(
        r"\b(?:in|as|using|include|provide|show)\s+pseudocode\b|"
        r"\bpseudocode\s+(?:for|of|showing)\b",
        text, re.IGNORECASE,
    ))
    return TaskRequirementContract(
        definition_topics=definition_topics,
        definition_requires_explicit_meaning=definition_requires_explicit_meaning,
        concrete_example=example is not None,
        concrete_example_terms=example_terms,
        stable_single_operation_outcome=stable_single_operation_outcome,
        deliverables=deliverables,
        authoritative_store=authoritative_store,
        forbidden_authoritative_stores=forbidden_authoritative_stores,
        comparison_terms=comparison_terms,
        explicit_subquestion_count=min(20, explicit_subquestions),
        transaction_boundary_required=transaction_boundary_required,
        pseudocode_required=pseudocode_required,
    )


_CONTEXT_ANCHOR_STOP = frozenset({
    "building", "details", "occasionally", "endpoint", "client", "change",
    "first", "likely", "failure", "mode", "should", "keep", "thread",
})


def _context_stack_terms(context_text: str) -> tuple[str, ...]:
    matches = list(re.finditer(
        r"\bwith\s+([^.!?\n]{3,160})",
        str(context_text or ""), re.IGNORECASE,
    ))
    if not matches:
        return ()
    segment = matches[-1].group(1)
    values = re.split(r"\s*,\s*|\s+and\s+", segment, flags=re.IGNORECASE)
    output: list[str] = []
    for value in values:
        candidate = re.sub(r"\s+", " ", value).strip(" `\"'()")
        candidate = re.sub(r"^(?:and|or)\s+", "", candidate, flags=re.I)
        if (
            candidate
            and len(candidate) <= 40
            and len(candidate.split()) <= 3
            and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.+ #/-]*", candidate)
        ):
            output.append(candidate)
    return tuple(dict.fromkeys(output))[:8]


def with_contextual_task_requirements(
    contract: TaskRequirementContract,
    *,
    message: str,
    context_turns: list[dict[str, str]],
    use_context: bool,
) -> TaskRequirementContract:
    """Attach bounded requirements for explicit same-thread follow-ups."""

    if not use_context or not context_turns:
        return contract
    prior_user_text = "\n".join(
        str(turn.get("user") or "")
        for turn in context_turns
        if str(turn.get("user") or "").strip()
    )[-8_000:]
    contextual_contract = replace(
        contract,
        prior_context_reask_forbidden=bool(prior_user_text),
    )
    current = str(message or "")
    referential = bool(re.search(
        r"\b(?:that|those|the fix|the approach|failure mode|change first)\b",
        current, re.IGNORECASE,
    ))
    if not referential or not prior_user_text:
        return contextual_contract
    stack_terms = _context_stack_terms(prior_user_text)
    anchors = tuple(
        term for term in _terms(prior_user_text, 40)
        if term not in _CONTEXT_ANCHOR_STOP
        and term.casefold() not in {item.casefold() for item in stack_terms}
    )[:8]
    duplicate_context = bool(
        re.search(
            r"\b(?:same|duplicate\w*|twice|again)\b[^.!?\n]{0,100}"
            r"\b(?:retry|request|reservation|operation)\b|"
            r"\b(?:retry|repeated request)\b[^.!?\n]{0,100}"
            r"\b(?:same|duplicate\w*|twice|again|reservation)\b",
            prior_user_text, re.IGNORECASE,
        )
    )
    asks_failure_and_change = bool(
        re.search(r"\bfailure mode\b", current, re.IGNORECASE)
        and re.search(r"\b(?:change|do|fix)\b[^.!?\n]{0,30}\bfirst\b|"
                      r"\bfirst\b[^.!?\n]{0,30}\b(?:change|do|fix)\b",
                      current, re.IGNORECASE)
    )
    return replace(
        contextual_contract,
        # A transaction-boundary follow-up must stay attached to the prior
        # reservation problem, but it need not gratuitously repeat every stack
        # component. The failure-mode/edit-branch question does require the
        # current stack so a superseded branch cannot leak back in.
        contextual_stack_terms=(
            () if contract.pseudocode_required else stack_terms
        ),
        contextual_anchor_terms=anchors,
        duplicate_retry_fix_required=(
            duplicate_context and asks_failure_and_change
        ),
    )


def with_repository_task_requirements(
    contract: TaskRequirementContract,
    *,
    message: str,
    validation_command: str | None,
    validation_mode: str | None,
    forbidden_stack_assumptions: tuple[str, ...] = (),
    actual_stack_terms: tuple[str, ...] = (),
    missing_path_response_required: bool = False,
) -> TaskRequirementContract:
    """Add repository-specific, deterministic requirements to a turn contract."""

    text = str(message or "")
    wants_diff = bool(re.search(r"\bunified\s+diff\b", text, re.IGNORECASE))
    asks_validation_claim = bool(
        re.search(r"\b(?:test|validation)\s+command\b", text, re.IGNORECASE)
        and re.search(r"\b(?:run|ran|claim|check|verify)\w*\b", text, re.IGNORECASE)
    )
    return replace(
        contract,
        repository_unified_diff_required=wants_diff,
        repository_patch_context_required=wants_diff,
        repository_validation_command=(
            validation_command if asks_validation_claim else None
        ),
        repository_validation_claim_mode=(
            validation_mode if asks_validation_claim else None
        ),
        repository_forbidden_stack_assumptions=tuple(dict.fromkeys(
            item.casefold() for item in forbidden_stack_assumptions if item
        ))[:8],
        repository_actual_stack_terms=tuple(dict.fromkeys(
            item.casefold() for item in actual_stack_terms if item
        ))[:12],
        repository_missing_path_response_required=bool(
            missing_path_response_required
        ),
    )


def _repository_patch_old_hunks(
    answer: str,
) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """Return each existing-file hunk's exact pre-image lines."""

    hunks: list[tuple[str, tuple[str, ...]]] = []
    current_path: str | None = None
    current_lines: list[str] | None = None

    def finish() -> None:
        nonlocal current_lines
        if current_path is not None and current_lines is not None:
            hunks.append((current_path, tuple(current_lines)))
        current_lines = None

    for line in str(answer or "").splitlines():
        if line.startswith("--- "):
            finish()
            raw_path = line[4:].strip().split("\t", 1)[0]
            current_path = (
                raw_path[2:] if raw_path.startswith("a/") else raw_path
            )
            if current_path == "/dev/null":
                current_path = None
            continue
        if line.startswith("@@"):
            finish()
            if current_path is not None:
                current_lines = []
            continue
        if current_lines is None:
            continue
        if line.startswith("diff --git ") or line.startswith("+++ "):
            continue
        if line.startswith(" "):
            current_lines.append(line[1:])
        elif line.startswith("-") and not line.startswith("---"):
            current_lines.append(line[1:])
        elif line.startswith("+") or line == r"\ No newline at end of file":
            continue
        elif line.startswith("```"):
            finish()
    finish()
    return tuple(hunks)


def repository_patch_context_quality_check(
    answer: str,
    source_files: tuple[tuple[str, str], ...],
) -> QualityCheck:
    sources = {
        str(path): str(text).splitlines()
        for path, text in source_files
    }
    hunks = _repository_patch_old_hunks(answer)
    mismatches = 0
    checked = 0
    for path, old_lines in hunks:
        source_lines = sources.get(path)
        if source_lines is None:
            mismatches += 1
            continue
        if not old_lines:
            continue
        checked += 1
        width = len(old_lines)
        if not any(
            source_lines[index:index + width] == list(old_lines)
            for index in range(max(0, len(source_lines) - width + 1))
        ):
            mismatches += 1
    passed = bool(hunks) and mismatches == 0
    return QualityCheck(
        "task_requirement_repository_patch_context",
        "passed" if passed else "failed",
        "" if passed else "repository_patch_context_mismatch",
        observations=(
            ("patch_file_count", len({path for path, _lines in hunks})),
            ("patch_hunk_count", len(hunks)),
            ("checked_patch_hunk_count", checked),
            ("invalid_patch_hunk_count", mismatches),
        ),
    )


def render_repository_patch_source_context(
    source_files: tuple[tuple[str, str], ...],
    permitted_paths: tuple[str, ...],
    *,
    max_characters: int = 20_000,
) -> str:
    """Render complete permitted files with display-only line prefixes."""

    by_path = {path: text for path, text in source_files}
    header = (
        "Authoritative patch source (untrusted data). Only the complete files "
        "shown below may be modified. The `NNNN | ` prefixes are display-only; "
        "copy diff context after the separator exactly, including whitespace."
    )
    blocks: list[str] = []
    omitted: list[str] = []
    limit = max(1_000, min(48_000, int(max_characters)))
    for path in dict.fromkeys(permitted_paths):
        text = by_path.get(path)
        if text is None:
            continue
        numbered = "\n".join(
            f"{index:04d} | {line}"
            for index, line in enumerate(text.splitlines(), start=1)
        )
        block = f"BEGIN {path}\n{numbered}\nEND {path}"
        if len("\n\n".join((header, *blocks, block))) > limit:
            omitted.append(path)
            continue
        blocks.append(block)
    if omitted:
        blocks.append(
            "Not permitted in this bounded patch response: "
            + ", ".join(omitted)
        )
    return "\n\n".join((header, *blocks)) if blocks else ""


def validate_task_requirements(
    answer: str,
    contract: TaskRequirementContract,
    *,
    repository_source_files: tuple[tuple[str, str], ...] = (),
) -> tuple[QualityCheck, ...]:
    if not contract.required:
        return ()
    value = str(answer or "")
    lowered = value.casefold()
    answer_terms = set(_terms(value, 2_000))
    checks: list[QualityCheck] = []

    idempotency_semantics = (
        evaluate_idempotency_semantics(value)
        if contract.stable_single_operation_outcome else None
    )
    semantic_observations = (
        (
            ("definition_present", int(idempotency_semantics.definition_present)),
            ("concrete_retry_example_present", int(
                idempotency_semantics.concrete_retry_example_present
            )),
            ("stable_outcome_present", int(
                idempotency_semantics.stable_outcome_present
            )),
            ("validator_version", idempotency_semantics.validator_version),
        )
        if idempotency_semantics else ()
    )

    if contract.definition_topics:
        topic_present = all(term in answer_terms for term in contract.definition_topics[:2])
        definition_language = bool(re.search(
            r"\b(?:means|is|refers to|ensures|allows|prevents|describes)\b",
            lowered,
        ))
        explicit_enough = (
            definition_language
            if contract.definition_requires_explicit_meaning
            else len(value.split()) >= 4
        )
        if idempotency_semantics:
            topic_present = idempotency_semantics.definition_present
            explicit_enough = idempotency_semantics.definition_present
        checks.append(QualityCheck(
            "task_requirement_definition",
            "passed" if topic_present and explicit_enough else "failed",
            "" if topic_present and explicit_enough else "required_definition_missing",
            observations=semantic_observations,
        ))

    if contract.concrete_example:
        relevant = (
            not contract.concrete_example_terms
            or any(term in answer_terms for term in contract.concrete_example_terms)
        )
        concrete = bool(re.search(
            r"\b(?:for example|example|e\.g\.|suppose|scenario)\b|"
            r"\b(?:GET|POST|PUT|PATCH|DELETE)\b|`[^`]+`|\b\d+[A-Za-z0-9_-]*\b",
            value, re.IGNORECASE,
        ))
        if idempotency_semantics:
            relevant = True
            concrete = idempotency_semantics.concrete_retry_example_present
        checks.append(QualityCheck(
            "task_requirement_example",
            "passed" if relevant and concrete else "failed",
            "" if relevant and concrete else "concrete_example_missing",
            observations=semantic_observations,
        ))

    if contract.stable_single_operation_outcome:
        stable = bool(
            idempotency_semantics and idempotency_semantics.stable_outcome_present
        )
        checks.append(QualityCheck(
            "task_requirement_stable_outcome",
            "passed" if stable else "failed",
            "" if stable else "stable_idempotent_outcome_missing",
            observations=semantic_observations,
        ))

    if contract.authoritative_store or contract.forbidden_authoritative_stores:
        authority = evaluate_authority_semantics(
            value,
            authoritative_store=contract.authoritative_store or "",
            forbidden_stores=contract.forbidden_authoritative_stores,
        )
        authority_observations = (
            ("authoritative_store_present", int(
                authority.authoritative_store_present
            )),
            ("forbidden_authority_passed", int(
                authority.forbidden_authority_passed
            )),
            ("forbidden_authority_violation", int(
                authority.forbidden_authority_violation
            )),
            ("validator_version", authority.validator_version),
        )
        if contract.authoritative_store:
            checks.append(QualityCheck(
                "task_requirement_authoritative_store",
                "passed" if authority.authoritative_store_present else "failed",
                "" if authority.authoritative_store_present
                else "authoritative_store_missing",
                observations=authority_observations,
            ))
        if contract.forbidden_authoritative_stores:
            checks.append(QualityCheck(
                "task_requirement_forbidden_authority",
                "passed" if authority.forbidden_authority_passed else "failed",
                "" if authority.forbidden_authority_passed
                else "forbidden_authoritative_store_claim",
                observations=authority_observations,
            ))

    if contract.comparison_terms:
        present = all(term in answer_terms for term in contract.comparison_terms)
        compared = bool(re.search(
            r"\b(?:whereas|while|compared|versus|trade-?off|difference|both)\b",
            lowered,
        ))
        checks.append(QualityCheck(
            "task_requirement_comparison",
            "passed" if present and compared else "failed",
            "" if present and compared else "named_comparison_missing",
        ))

    if contract.repository_unified_diff_required:
        minus = re.search(r"(?m)^---\s+(?:a/)?[^\s]+\s*$", value)
        plus = re.search(r"(?m)^\+\+\+\s+(?:b/)?[^\s]+\s*$", value)
        hunk = re.search(r"(?m)^@@\s+[-+0-9, ]+@@", value)
        intact = bool(minus and plus and hunk and minus.start() < plus.start() < hunk.start())
        checks.append(QualityCheck(
            "task_requirement_repository_unified_diff",
            "passed" if intact else "failed",
            "" if intact else "repository_unified_diff_missing",
            observations=(
                ("minus_header_present", int(minus is not None)),
                ("plus_header_present", int(plus is not None)),
                ("hunk_header_present", int(hunk is not None)),
            ),
        ))
    if contract.repository_patch_context_required:
        checks.append(repository_patch_context_quality_check(
            value, repository_source_files,
        ))

    if contract.repository_validation_command:
        command_present = contract.repository_validation_command in value
        run_claim = bool(re.search(
            r"\b(?:tests?|checks?|lint|build|typecheck)\b[^.\n]{0,60}"
            r"\b(?:ran|run|passed|pass|succeeded|verified)\b|"
            r"\b(?:ran|run|passed|succeeded|verified)\b[^.\n]{0,60}"
            r"\b(?:tests?|checks?|lint|build|typecheck)\b",
            value, re.IGNORECASE,
        ))
        honest_unexecuted = bool(re.search(
            r"\b(?:not|wasn['’]?t|didn['’]?t|cannot|can['’]?t|unable)\b"
            r"[^.\n]{0,60}\b(?:run|execute|claim|verify)\w*\b|"
            r"\b(?:static[- ]only|unverified|not executed)\b",
            value, re.IGNORECASE,
        ))
        claim_matches = (
            honest_unexecuted and not run_claim
            if contract.repository_validation_claim_mode in {
                "static_only", "unavailable"
            }
            else True
        )
        passed = command_present and claim_matches
        checks.append(QualityCheck(
            "task_requirement_repository_validation_claim",
            "passed" if passed else "failed",
            "" if passed else "repository_validation_claim_inaccurate",
            observations=(
                ("command_present", int(command_present)),
                ("claim_matches_capability", int(claim_matches)),
                ("validation_mode", contract.repository_validation_claim_mode or ""),
            ),
        ))

    if contract.repository_forbidden_stack_assumptions:
        rejected: list[str] = []
        for framework in contract.repository_forbidden_stack_assumptions:
            escaped = re.escape(framework)
            if re.search(
                rf"\b(?:not|isn['’]?t|doesn['’]?t|no)\b[^.\n]{{0,50}}\b{escaped}\b|"
                rf"\b{escaped}\b[^.\n]{{0,50}}\b(?:not|absent|unsupported|not used)\b",
                value, re.IGNORECASE,
            ):
                rejected.append(framework)
        actual_stack_present = bool(
            contract.repository_actual_stack_terms
            and any(
                re.search(rf"\b{re.escape(term)}\b", value, re.IGNORECASE)
                for term in contract.repository_actual_stack_terms
            )
        )
        passed = (
            len(rejected) == len(contract.repository_forbidden_stack_assumptions)
            and actual_stack_present
        )
        checks.append(QualityCheck(
            "task_requirement_repository_stack",
            "passed" if passed else "failed",
            "" if passed else "repository_stack_assumption_not_rejected",
            observations=(
                ("unsupported_assumption_count", len(
                    contract.repository_forbidden_stack_assumptions
                )),
                ("rejected_assumption_count", len(rejected)),
                ("actual_stack_present", int(actual_stack_present)),
            ),
        ))

    if contract.repository_missing_path_response_required:
        honest_absence = bool(re.search(
            r"\b(?:not found|wasn['’]?t found|does not exist|doesn['’]?t exist|"
            r"absent|not present|no such file|cannot determine|can['’]?t determine)\b",
            value, re.IGNORECASE,
        ))
        invented_behavior = bool(re.search(
            r"\b(?:it|this file|the file)\s+"
            r"(?:defines?|implements?|imports?|exports?|calls?|handles?|returns?|contains?)\b",
            value, re.IGNORECASE,
        ))
        passed = honest_absence and not invented_behavior
        checks.append(QualityCheck(
            "task_requirement_repository_missing_path",
            "passed" if passed else "failed",
            "" if passed else "repository_missing_path_answer_invented",
            observations=(
                ("honest_absence_present", int(honest_absence)),
                ("invented_behavior_present", int(invented_behavior)),
            ),
        ))

    fenced_ranges = tuple(
        (match.start(), match.end())
        for match in re.finditer(r"```.*?```", value, re.DOTALL)
    )
    candidates = [
        match for match in _ANSWER_NUMBERED.finditer(value)
        if not any(start <= match.start() < end for start, end in fenced_ranges)
    ]
    numbered_sections: list[re.Match[str]] = []
    expected_ordinals = [item.ordinal for item in contract.deliverables]
    expected_index = 0
    for match in candidates:
        if (
            expected_index < len(expected_ordinals)
            and int(match.group(1)) == expected_ordinals[expected_index]
        ):
            numbered_sections.append(match)
            expected_index += 1
    section_text: dict[int, set[str]] = {}
    for index, match in enumerate(numbered_sections):
        end = (
            numbered_sections[index + 1].start()
            if index + 1 < len(numbered_sections) else len(value)
        )
        section_text[int(match.group(1))] = set(
            _terms(value[match.start():end], 400)
        )
    architecture_area_ids = architecture_area_ids_for_contract(contract)
    if architecture_area_ids:
        architecture = evaluate_architecture_coverage(value)
        for area in architecture.areas:
            checks.append(QualityCheck(
                f"task_architecture_{area.area_identifier}",
                "passed" if area.passed else "failed",
                "" if area.passed else "architecture_area_missing",
                observations=(
                    ("area_identifier", area.area_identifier),
                    ("heading_present", int(area.heading_present)),
                    ("semantic_mechanism_present", int(
                        area.semantic_mechanism_present
                    )),
                    ("stable_side_effect_outcome_present", int(
                        area.stable_side_effect_outcome_present
                    )),
                    ("validator_version", area.validator_version),
                ),
            ))
    else:
        for deliverable in contract.deliverables:
            terms_in_section = section_text.get(deliverable.ordinal, set())
            term_overlap = sum(term in terms_in_section for term in deliverable.terms)
            required_overlap = 1 if len(deliverable.terms) <= 2 else 2
            passed = (
                deliverable.ordinal in section_text
                and term_overlap >= min(required_overlap, len(deliverable.terms))
            )
            checks.append(QualityCheck(
                f"task_deliverable_{deliverable.ordinal:02d}",
                "passed" if passed else "failed",
                "" if passed else f"missing_deliverable_{deliverable.ordinal:02d}",
            ))

    if contract.explicit_subquestion_count:
        answered = len(re.findall(r"(?m)^\s*(?:\d+[.)]|[-*+])\s+\S+", value))
        passed = answered >= contract.explicit_subquestion_count
        checks.append(QualityCheck(
            "task_requirement_subquestions",
            "passed" if passed else "failed",
            "" if passed else "explicit_subquestions_missing",
        ))
    if contract.transaction_boundary_required:
        transaction_boundary_present = bool(
            re.search(r"\b(?:transaction|atomic)\b", lowered)
            and re.search(r"\b(?:begin|start|open)\w*\b", lowered)
            and re.search(r"\b(?:commit|rollback|roll back)\w*\b", lowered)
        )
        checks.append(QualityCheck(
            "task_requirement_transaction_boundary",
            "passed" if transaction_boundary_present else "failed",
            "" if transaction_boundary_present
            else "transaction_boundary_missing",
            observations=((
                "transaction_boundary_present",
                int(transaction_boundary_present),
            ),),
        ))
    if contract.pseudocode_required:
        pseudocode_present = bool(
            re.search(r"```[^\n]*\n[\s\S]*?```", value)
            or re.search(
                r"(?im)^\s*(?:begin|if|for|while|insert|select|update|"
                r"commit|rollback|return|def|function)\b",
                value,
            )
        )
        checks.append(QualityCheck(
            "task_requirement_pseudocode",
            "passed" if pseudocode_present else "failed",
            "" if pseudocode_present else "pseudocode_missing",
            observations=(("pseudocode_present", int(pseudocode_present)),),
        ))
    if contract.contextual_stack_terms or contract.contextual_anchor_terms:
        stack_present_count = sum(
            term.casefold() in lowered
            for term in contract.contextual_stack_terms
        )
        anchor_present_count = sum(
            re.search(rf"\b{re.escape(term.casefold())}\b", lowered) is not None
            for term in contract.contextual_anchor_terms
        )
        context_passed = bool(
            stack_present_count == len(contract.contextual_stack_terms)
            and (
                not contract.contextual_anchor_terms
                or anchor_present_count > 0
            )
        )
        checks.append(QualityCheck(
            "task_requirement_context_grounding",
            "passed" if context_passed else "failed",
            "" if context_passed else "prior_turn_context_missing",
            observations=(
                ("context_stack_term_count", len(contract.contextual_stack_terms)),
                ("context_stack_term_present_count", stack_present_count),
                ("context_anchor_count", len(contract.contextual_anchor_terms)),
                ("context_anchor_present_count", anchor_present_count),
            ),
        ))
    if contract.prior_context_reask_forbidden:
        context_reask_detected = bool(re.search(
            r"(?im)(?:^|[.!?]\s+)"
            r"(?:(?:please|can\s+you|could\s+you|would\s+you)\s+)?"
            r"(?:share|provide|send|describe|specify|tell\s+me|give\s+me)\b"
            r"[^.!?]{0,120}\b(?:system|stack|technolog\w*|framework|database|"
            r"symptoms?|recent\s+changes?|errors?|logs?|problem|issue|details?|"
            r"context|information)\b|"
            r"(?:^|[.!?]\s+)(?:i|we)\s+(?:will|'ll|would)?\s*need\b"
            r"[^.!?]{0,60}\b(?:information|details|context)\b",
            value,
        ))
        checks.append(QualityCheck(
            "task_requirement_prior_context_reask",
            "failed" if context_reask_detected else "passed",
            "prior_context_reasked" if context_reask_detected else "",
            observations=((
                "prior_context_reask_detected",
                int(context_reask_detected),
            ),),
        ))
    if contract.duplicate_retry_fix_required:
        failure_mode_present = bool(re.search(
            r"\b(?:idempoten\w*|duplicate\w*|deduplicat\w*|race condition|"
            r"replay|retry\w*[^.;]{0,40}(?:same|twice|duplicate))\b",
            lowered,
        ))
        first_change_present = bool(re.search(
            r"\b(?:unique\w*|constraint|idempotency key|request key|"
            r"operation key|on conflict|deduplicat\w*)\b",
            lowered,
        ))
        transactional_fix_present = bool(
            re.search(r"\b(?:transaction|atomic|commit|rollback)\b", lowered)
        )
        passed = (
            failure_mode_present
            and first_change_present
            and transactional_fix_present
        )
        checks.append(QualityCheck(
            "task_requirement_duplicate_retry_fix",
            "passed" if passed else "failed",
            "" if passed else "duplicate_retry_fix_incomplete",
            observations=(
                ("failure_mode_present", int(failure_mode_present)),
                ("first_change_present", int(first_change_present)),
                ("transactional_fix_present", int(transactional_fix_present)),
            ),
        ))
    return tuple(checks)
