from __future__ import annotations

import json
from pathlib import Path

from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.sentence_segmentation import count_sentences
from app.web_ai.generation.task_requirements import (
    evaluate_authority_semantics, evaluate_idempotency_semantics,
    extract_task_requirements, validate_task_requirements,
)


B01 = (
    "Explain idempotency in payment APIs to a junior developer. Use exactly "
    "four bullet points, include one concrete retry example, and use no more "
    "than 140 words."
)


def test_b01_semantic_requirements_require_definition_and_retry_example():
    contract = extract_task_requirements(B01)
    assert contract.definition_topics[:2] == ("idempotency", "payment")
    assert contract.concrete_example_terms == ("retry",)

    incomplete = validate_task_requirements(
        "- Use a key.\n- Store it.\n- Return it.\n- Keep it unique.", contract
    )
    assert {check.reason_code for check in incomplete if check.status == "failed"} == {
        "required_definition_missing", "concrete_example_missing",
        "stable_idempotent_outcome_missing",
    }
    complete = validate_task_requirements(
        "- Idempotency in a payment API means one logical operation has one result.\n"
        "- Store a unique idempotency key.\n"
        "- For example, retry POST /payments with key RETRY-1 and return the first result.\n"
        "- This prevents a duplicate charge.",
        contract,
    )
    assert all(check.status == "passed" for check in complete)


def test_python_and_browser_share_capability_semantic_fixtures():
    fixture = Path(__file__).parents[2] / "shared-fixtures" / "capability-semantics.json"
    cases = json.loads(fixture.read_text(encoding="utf-8"))
    for case in cases["idempotency"]:
        result = evaluate_idempotency_semantics(case["text"])
        assert result.definition_present is case["definition_present"], case["id"]
        assert result.concrete_retry_example_present is case[
            "concrete_retry_example_present"
        ], case["id"]
        assert result.stable_outcome_present is case["stable_outcome_present"], case["id"]
    for case in cases["architecture_authority"]:
        result = evaluate_authority_semantics(
            case["text"], authoritative_store="PostgreSQL",
            forbidden_stores=("Redis", "Valkey"),
        )
        assert result.authoritative_store_present is case[
            "postgres_authoritative"
        ], case["id"]
        assert result.forbidden_authority_passed is case[
            "redis_valkey_forbidden_authority_passed"
        ], case["id"]
        assert result.forbidden_authority_violation is case["violation"], case["id"]


def test_markdown_numbered_deliverables_preserve_top_level_order():
    prompt = "Include:\n" + "\n".join(
        f"{index}. section topic {index}" for index in range(1, 11)
    )
    contract = extract_task_requirements(prompt)
    formats = (
        "{ordinal}. {label}", "{ordinal}) {label}",
        "### {ordinal}. {label}", "**{ordinal}. {label}**",
        "### {ordinal}) **{label}**",
    )
    for heading_format in formats:
        sections = []
        for item in contract.deliverables:
            sections.append(heading_format.format(
                ordinal=item.ordinal, label=item.label,
            ) + "\nCovered details.")
            if item.ordinal == 4:
                sections.append("```text\n5. inner pseudocode step\n```")
        checks = validate_task_requirements("\n".join(sections), contract)
        assert all(check.status == "passed" for check in checks), heading_format


def test_authoritative_store_constraint_is_extracted_and_verified():
    prompt = (
        "Design the architecture.\n"
        "- PostgreSQL is the source of truth\n"
        "- Redis or Valkey must not be the source of truth"
    )
    contract = extract_task_requirements(prompt)
    assert contract.authoritative_store == "PostgreSQL"
    assert contract.forbidden_authoritative_stores == ("Redis", "Valkey")
    assert "non-authoritative" in contract.prompt_instruction(1_000)
    checks = validate_task_requirements(
        "PostgreSQL is the system of record. "
        "Redis and Valkey are non-authoritative caches.",
        contract,
    )
    assert all(check.status == "passed" for check in checks)


def test_ten_deliverables_are_coverage_first_and_report_exact_missing_item():
    prompt = "Include:\n" + "\n".join(
        f"{index}. section topic {index}" for index in range(1, 11)
    )
    contract = extract_task_requirements(prompt)
    instruction = contract.prompt_instruction(1200)
    assert len(contract.deliverables) == 10
    assert "Cover all 10" in instruction
    answer = "\n".join(
        f"{index}. Section topic {index}: covered." for index in range(1, 10)
    )
    failed = [
        check for check in validate_task_requirements(answer, contract)
        if check.status == "failed"
    ]
    assert [check.check_type for check in failed] == ["task_deliverable_10"]
    quality = AnswerGuard().check(
        answer,
        AnswerGuardContext(
            answer_class="long_form", task_contract=prompt,
            task_requirements=contract,
        ),
    )
    assert quality.status == "unverified"


def test_python_sentence_segmenter_matches_shared_fixtures():
    fixture = Path(__file__).parents[2] / "shared-fixtures" / "sentence-segmentation.json"
    cases = json.loads(fixture.read_text(encoding="utf-8"))
    assert cases
    for case in cases:
        assert count_sentences(case["text"]) == case["count"], case["id"]
