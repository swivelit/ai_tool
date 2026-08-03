from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import re
from typing import Any

from .models import QualityCheck


TASK_REQUIREMENT_VERSION = "2026-08-03.3"
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


def _architecture_sections(answer: str) -> dict[str, tuple[bool, str]]:
    value = str(answer or "")
    fenced_ranges = tuple(
        (match.start(), match.end())
        for match in re.finditer(r"```.*?```", value, re.DOTALL)
    )
    matches = [
        match for match in _ANSWER_NUMBERED.finditer(value)
        if not any(start <= match.start() < end for start, end in fenced_ranges)
    ]
    sections: dict[str, tuple[bool, str]] = {}
    last_match_index = -1
    for index, match in enumerate(matches):
        ordinal = int(match.group(1))
        if ordinal < 1 or ordinal > len(ARCHITECTURE_AREA_IDENTIFIERS):
            continue
        area_identifier = _architecture_area_from_label(match.group(2))
        expected_area = ARCHITECTURE_AREA_IDENTIFIERS[ordinal - 1]
        if area_identifier != expected_area or index <= last_match_index:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(value)
        label_parts = re.split(
            r"\s+(?:[-\u2010-\u2015\u2212]|:)\s+",
            match.group(2), maxsplit=1,
        )
        inline_detail = label_parts[1] if len(label_parts) == 2 else ""
        sections[expected_area] = (
            True,
            normalize_architecture_semantics(
                inline_detail + "\n" + value[match.end():end]
            ),
        )
        last_match_index = index
    return sections


def _architecture_mechanism(area_identifier: str, value: str) -> bool:
    if area_identifier == "database_schema":
        return bool(
            re.search(r"\b(?:tables?|schema|event inbox|webhook events?|payments?|wallet ledger)\b", value)
            and re.search(r"\b(?:unique|primary key|constraint|provider event id)\b", value)
        )
    patterns = {
        "transaction_boundaries": r"\b(?:atomic transaction|begin|commit|rollback|select for update|transaction boundar\w*|same transaction)\b",
        "state_transitions": r"\b(?:state transitions?|state machine|status transitions?|payment lifecycle|event lifecycle|monotonic transition)\b",
        "pseudocode": r"\b(?:pseudocode|algorithm|processing flow|handler flow|worker flow|process event|begin transaction)\b",
        "out_of_order_handling": r"\b(?:out of order|late event|event ordering|reorder|sequence gap|monotonic state)\b",
        "failure_recovery": r"\b(?:failure recovery|retryable inbox|safe replay|dead letter|crash recovery|lease recovery)\b",
        "reconciliation": r"\b(?:reconciliation|reconcile|audit job|consistency check|provider poll)\b",
        "security_checks": r"\b(?:security checks?|signature verification|hmac|replay attack|replay window|timestamp validation|raw body)\b",
        "test_plan": r"\b(?:test plan|testing strategy|test cases?|concurrency test|failure injection|integration tests?)\b",
    }
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
    normalized_answer = normalize_architecture_semantics(answer)
    sections = _architecture_sections(answer)
    areas: list[ArchitectureAreaEvaluation] = []
    for area_identifier in ARCHITECTURE_AREA_IDENTIFIERS:
        heading_present, section_value = sections.get(
            area_identifier, (False, normalized_answer)
        )
        if area_identifier == "duplicate_handling":
            mechanism, stable = _duplicate_semantics(section_value)
            passed = mechanism or stable
        else:
            mechanism = _architecture_mechanism(area_identifier, section_value)
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
        comparison_terms = _terms(
            comparison.group(1) + " " + comparison.group(2), 12
        )

    explicit_subquestions = len(re.findall(r"(?m)^\s*(?:\d+[.)]|[-*+])\s+[^\n?]+\?\s*$", text))
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
    )


def validate_task_requirements(
    answer: str,
    contract: TaskRequirementContract,
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
    return tuple(checks)
