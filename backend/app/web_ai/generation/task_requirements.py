from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import re
from typing import Any

from .models import QualityCheck


TASK_REQUIREMENT_VERSION = "2026-08-03.1"
_NUMBERED = re.compile(r"(?m)^\s*(\d{1,2})[.)]\s+(.{3,240}?)\s*$")
_WORD = re.compile(r"[A-Za-z0-9_+-]+", re.UNICODE)
_STOP = {
    "a", "an", "and", "are", "be", "for", "in", "include", "of", "on",
    "or", "the", "to", "using", "with", "must", "should", "handling",
}


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
    deliverables: tuple[RequiredDeliverable, ...] = ()
    comparison_terms: tuple[str, ...] = ()
    explicit_subquestion_count: int = 0
    version: str = TASK_REQUIREMENT_VERSION

    @property
    def required(self) -> bool:
        return bool(
            self.definition_topics
            or self.concrete_example
            or self.deliverables
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
            deliverables=tuple(deliverables),
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

    deliverables = tuple(
        RequiredDeliverable(int(number), label.strip()[:240], _terms(label))
        for number, label in _NUMBERED.findall(text)[:20]
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
        deliverables=deliverables,
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
        checks.append(QualityCheck(
            "task_requirement_definition",
            "passed" if topic_present and explicit_enough else "failed",
            "" if topic_present and explicit_enough else "required_definition_missing",
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
        checks.append(QualityCheck(
            "task_requirement_example",
            "passed" if relevant and concrete else "failed",
            "" if relevant and concrete else "concrete_example_missing",
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

    numbered_sections = list(re.finditer(
        r"(?m)^\s*(\d{1,2})[.)]\s+(.+?)\s*$", value
    ))
    section_text: dict[int, set[str]] = {}
    for index, match in enumerate(numbered_sections):
        end = (
            numbered_sections[index + 1].start()
            if index + 1 < len(numbered_sections) else len(value)
        )
        section_text[int(match.group(1))] = set(
            _terms(value[match.start():end], 400)
        )
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
