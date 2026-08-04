from __future__ import annotations

import json
from pathlib import Path

from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.sentence_segmentation import count_sentences
from app.web_ai.generation.task_requirements import (
    TASK_REQUIREMENT_VERSION, evaluate_architecture_coverage,
    evaluate_authority_semantics,
    evaluate_idempotency_semantics,
    extract_task_requirements, splice_architecture_section_repair,
    validate_task_requirements, with_repository_task_requirements,
)


B01 = (
    "Explain idempotency in payment APIs to a junior developer. Use exactly "
    "four bullet points, include one concrete retry example, and use no more "
    "than 140 words."
)
B03 = """Design an idempotent webhook architecture.
Constraints:
- PostgreSQL is the source of truth
- Redis or Valkey must not be the source of truth
Include:
1. database tables and unique constraints
2. transaction boundaries
3. event and payment state transitions
4. pseudocode
5. duplicate-event handling
6. out-of-order handling
7. failure recovery
8. reconciliation
9. security checks
10. a focused test plan"""


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
    assert TASK_REQUIREMENT_VERSION == "2026-08-03.6"
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
    for case in cases["architecture_coverage"]:
        result = evaluate_architecture_coverage(case["text"])
        assert list(result.covered_area_identifiers) == case[
            "covered_areas"
        ], case["id"]
        assert list(result.missing_area_identifiers) == case[
            "missing_areas"
        ], case["id"]
        duplicate = next(
            item for item in result.areas
            if item.area_identifier == "duplicate_handling"
        )
        assert duplicate.heading_present is case[
            "duplicate_heading_present"
        ], case["id"]
        assert duplicate.semantic_mechanism_present is case[
            "duplicate_semantic_mechanism_present"
        ], case["id"]
        assert duplicate.stable_side_effect_outcome_present is case[
            "duplicate_stable_side_effect_outcome_present"
        ], case["id"]
        assert result.validator_version == "2026-08-03.6", case["id"]


def test_architecture_headings_without_semantics_remain_unverified():
    contract = extract_task_requirements(B03)
    headings_only = (
        "PostgreSQL is the source of truth. Redis and Valkey are "
        "non-authoritative caches.\n"
        + "\n".join(
            f"### {item.ordinal}. {item.label}"
            for item in contract.deliverables
        )
    )
    checks = validate_task_requirements(headings_only, contract)
    architecture_checks = [
        check for check in checks
        if check.check_type.startswith("task_architecture_")
    ]
    assert len(architecture_checks) == 10
    assert all(check.status == "failed" for check in architecture_checks)
    duplicate = next(
        check for check in architecture_checks
        if check.check_type == "task_architecture_duplicate_handling"
    )
    duplicate_observations = dict(duplicate.observations)
    assert {
        key: duplicate_observations[key]
        for key in (
            "area_identifier", "heading_present",
            "semantic_mechanism_present",
            "stable_side_effect_outcome_present",
        )
    } == {
        "area_identifier": "duplicate_handling",
        "heading_present": 1,
        "semantic_mechanism_present": 0,
        "stable_side_effect_outcome_present": 0,
    }
    assert duplicate_observations["validator_version"]
    assert AnswerGuard().check(
        headings_only,
        AnswerGuardContext(
            answer_class="long_form",
            task_contract=B03,
            task_requirements=contract,
        ),
    ).status == "unverified"


def test_architecture_section_splice_preserves_passing_sections_byte_for_byte():
    prior = """### 1. Database tables and unique constraints
Use event tables with a UNIQUE provider event ID.
### 2. Transaction boundaries
Use one atomic transaction and commit or rollback.
### 3. Event and payment state transitions
Use monotonic state transitions and a status rank.
### 4. Pseudocode
The worker function inserts an event and commits.
### 5. Duplicate-event handling
Use INSERT ON CONFLICT DO NOTHING for an already processed event.
### 6. Out-of-order handling
Events arriving out of sequence are deferred; outdated updates are discarded.
### 7. Failure recovery
Requeue pending events after a crash and resume expired leases.
### 8. Reconciliation
Run a reconciliation audit job against PostgreSQL.
### 9. Security checks
Protect the webhook.
### 10. A focused test plan
Cover duplicates, concurrency, and crash recovery scenarios."""
    repair = """### 9. Security checks
Verify the X-Razorpay-Signature header against the webhook secret using a constant-time comparison."""
    original_section_six = prior[
        prior.index("### 6. Out-of-order handling"):
        prior.index("### 7. Failure recovery")
    ]
    spliced = splice_architecture_section_repair(
        prior, repair, ("security_checks",)
    )
    assert spliced is not None
    assert spliced[
        spliced.index("### 6. Out-of-order handling"):
        spliced.index("### 7. Failure recovery")
    ] == original_section_six
    assert evaluate_architecture_coverage(spliced).missing_area_identifiers == ()


def test_architecture_quality_observations_never_contain_answer_text():
    private_phrase = "private architecture response phrase"
    contract = extract_task_requirements(B03)
    checks = validate_task_requirements(
        f"### 5. Duplicate-event handling\n{private_phrase}", contract
    )
    encoded = json.dumps(
        [check.safe_summary for check in checks], sort_keys=True
    )
    assert private_phrase not in encoded
    assert "area_identifier" in encoded


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
    instruction = contract.prompt_instruction(1_000)
    assert "one dedicated sentence" in instruction
    assert "PostgreSQL is the system of record" in instruction
    assert "separate dedicated sentence" in instruction
    assert "Redis, Valkey" in instruction
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


def test_repository_unified_diff_requirement_rejects_prose_and_accepts_intact_diff():
    contract = with_repository_task_requirements(
        extract_task_requirements("Provide a minimal unified diff."),
        message="Provide a minimal unified diff.",
        validation_command=None,
        validation_mode="static_only",
    )
    failed = validate_task_requirements("Change src/app.js.", contract)
    assert failed[-1].check_type == "task_requirement_repository_unified_diff"
    assert failed[-1].status == "failed"
    answer = """```diff
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-return 1
+return 2
```"""
    assert validate_task_requirements(answer, contract)[-1].status == "passed"


def test_repository_validation_claim_must_match_static_only_capability():
    contract = with_repository_task_requirements(
        extract_task_requirements(
            "What test command is defined and which checks can you claim were run?"
        ),
        message="What test command is defined and which checks can you claim were run?",
        validation_command="npm test",
        validation_mode="static_only",
    )
    passing = validate_task_requirements(
        "The command is `npm test`. Validation is static-only, so tests were not executed.",
        contract,
    )
    assert passing[-1].status == "passed"
    failing = validate_task_requirements(
        "The command is `npm test`; all tests passed.", contract,
    )
    assert failing[-1].status == "failed"


def test_repository_stack_requirement_rejects_unsupported_react_assumption():
    contract = with_repository_task_requirements(
        extract_task_requirements("Refactor this repository to React."),
        message="Refactor this repository to React.",
        validation_command="npm test",
        validation_mode="static_only",
        forbidden_stack_assumptions=("react",),
        actual_stack_terms=("javascript",),
    )
    assert validate_task_requirements(
        "This is a JavaScript repository, not a React application.", contract,
    )[-1].status == "passed"
    assert validate_task_requirements(
        "Add a React component and useOptimistic.", contract,
    )[-1].status == "failed"


def test_repository_missing_path_requires_honest_absence_without_invention():
    contract = with_repository_task_requirements(
        extract_task_requirements("What does src/missing.ts do?"),
        message="What does src/missing.ts do?",
        validation_command=None,
        validation_mode="static_only",
        missing_path_response_required=True,
    )
    assert validate_task_requirements(
        "The requested file was not found in the complete repository index.",
        contract,
    )[-1].status == "passed"
    assert validate_task_requirements(
        "The file implements authentication and exports login().", contract,
    )[-1].status == "failed"
