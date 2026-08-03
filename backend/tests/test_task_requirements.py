from __future__ import annotations

import json
from pathlib import Path

from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.sentence_segmentation import count_sentences
from app.web_ai.generation.task_requirements import (
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
    }
    complete = validate_task_requirements(
        "- Idempotency in a payment API means one logical operation has one result.\n"
        "- Store a unique idempotency key.\n"
        "- For example, retry POST /payments with key RETRY-1 and return the first result.\n"
        "- This prevents a duplicate charge.",
        contract,
    )
    assert all(check.status == "passed" for check in complete)


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
