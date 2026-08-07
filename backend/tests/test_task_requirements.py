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
    render_repository_patch_source_context, validate_task_requirements,
    with_contextual_task_requirements, with_repository_task_requirements,
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


def test_explicit_transaction_boundary_pseudocode_is_repairable():
    contract = extract_task_requirements(
        "Show the transaction boundary for that fix in pseudocode."
    )
    assert contract.transaction_boundary_required is True
    assert contract.pseudocode_required is True

    terse = validate_task_requirements(
        "Use one atomic operation for the reservation.", contract,
    )
    assert {check.check_type for check in terse if check.status == "failed"} == {
        "task_requirement_transaction_boundary",
        "task_requirement_pseudocode",
    }

    complete = validate_task_requirements(
        "```text\nBEGIN TRANSACTION\nUPDATE inventory\n"
        "IF conflict: ROLLBACK\nCOMMIT\n```",
        contract,
    )
    assert all(check.status == "passed" for check in complete)


def test_repository_diff_instruction_requires_a_header_for_every_file():
    contract = with_repository_task_requirements(
        extract_task_requirements("Provide a minimal unified diff."),
        message="Provide a minimal unified diff.",
        validation_command="npm test",
        validation_mode="static_only",
    )

    instruction = contract.prompt_instruction(6000)

    assert "header for every changed file" in instruction
    assert "diff --git a/<path> b/<path>" in instruction


def test_comparison_contract_excludes_a_following_explanation_task():
    contract = extract_task_requirements(
        "Using only the attached Word document, compare Policy Alpha and "
        "Policy Beta retention and explain the legal-hold exception."
    )

    assert contract.comparison_terms == (
        "policy", "alpha", "beta", "retention",
    )
    checks = validate_task_requirements(
        "Policy Alpha retains data for 30 days, whereas Policy Beta retention "
        "is 90 days. A legal hold suspends deletion until release.",
        contract,
    )
    comparison = next(
        check for check in checks
        if check.check_type == "task_requirement_comparison"
    )
    assert comparison.status == "passed"


def test_python_and_browser_share_capability_semantic_fixtures():
    assert TASK_REQUIREMENT_VERSION == "2026-08-03.8"
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
        assert result.validator_version == "2026-08-03.8", case["id"]


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

    verbose_repair = (
        "Here are the corrected sections.\n"
        + prior.replace(
            "### 9. Security checks\nProtect the webhook.",
            "### 9. Security checks\nVerify the webhook HMAC signature.",
        )
    )
    tolerant_splice = splice_architecture_section_repair(
        prior, verbose_repair, ("security_checks",)
    )
    assert tolerant_splice is not None
    assert tolerant_splice.startswith("### 1. Database tables")
    assert "Here are the corrected sections" not in tolerant_splice
    assert "Verify the webhook HMAC signature" in tolerant_splice


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
    unified = next(
        check for check in failed
        if check.check_type == "task_requirement_repository_unified_diff"
    )
    assert unified.status == "failed"
    answer = """```diff
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-return 1
+return 2
```"""
    checks = validate_task_requirements(
        answer, contract,
        repository_source_files=(("src/app.js", "return 1\n"),),
    )
    assert all(check.status == "passed" for check in checks)


def test_repository_patch_context_must_match_real_fixture_verbatim():
    source = """import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrder } from '../src/orderService.js'
import { finalPrice } from '../src/pricing.js'

test('applies a percentage discount', () => {
  assert.equal(finalPrice(10000, 15), 8500)
})

test('creates an order with the discounted total', () => {
  assert.deepEqual(
    createOrder({
      id: 'ORDER-1',
      subtotalCents: 10000,
      discountPercent: 15,
    }),
    {
      id: 'ORDER-1',
      totalCents: 8500,
    },
  )
})

test('rejects an invalid percentage', () => {
  assert.throws(() => finalPrice(10000, 101))
})
"""
    source_files = (("test/order.test.js", source),)
    contract = with_repository_task_requirements(
        extract_task_requirements("Provide a minimal unified diff."),
        message="Provide a minimal unified diff.",
        validation_command=None,
        validation_mode="static_only",
    )
    correct = """```diff
diff --git a/test/order.test.js b/test/order.test.js
--- a/test/order.test.js
+++ b/test/order.test.js
@@ -10,4 +10,4 @@
 test('creates an order with the discounted total', () => {
   assert.deepEqual(
-    createOrder({
+    createOrder({
       id: 'ORDER-1',
```"""
    collapsed = """```diff
diff --git a/test/order.test.js b/test/order.test.js
--- a/test/order.test.js
+++ b/test/order.test.js
@@ -10,2 +10,2 @@
 test('creates an order with the discounted total', () => {
-  assert.deepEqual(createOrder({ id: 'ORDER-SWICO-CAP-RUN', subtotalCents: 10000, discountPercent: 15 }), { id: 'ORDER-SWICO-CAP-RUN', totalCents: 8500 })
+  assert.deepEqual(createOrder({ id: 'ORDER-1', subtotalCents: 10000, discountPercent: 15 }), { id: 'ORDER-1', totalCents: 8500 })
```"""

    def context_check(answer: str):
        return next(
            check for check in validate_task_requirements(
                answer, contract, repository_source_files=source_files,
            )
            if check.check_type == "task_requirement_repository_patch_context"
        )

    assert context_check(correct).status == "passed"
    failed = context_check(collapsed)
    assert failed.status == "failed"
    assert failed.reason_code == "repository_patch_context_mismatch"
    rendered = render_repository_patch_source_context(
        source_files, ("test/order.test.js",),
    )
    assert "0011 |   assert.deepEqual(" in rendered
    assert "0013 |       id: 'ORDER-1'," in rendered


def test_contextual_failure_fix_and_edited_stack_are_mandatory():
    prompt = "What is the most likely failure mode, and what should I change first?"
    original_context = [{
        "user": (
            "I am building an inventory API with FastAPI, PostgreSQL, and Redis. "
            "The stock-reservation endpoint occasionally applies the same "
            "reservation twice after a client retry."
        ),
        "assistant": "Understood.",
    }]
    contract = with_contextual_task_requirements(
        extract_task_requirements(prompt),
        message=prompt,
        context_turns=original_context,
        use_context=True,
    )
    assert contract.duplicate_retry_fix_required is True
    assert contract.contextual_stack_terms == (
        "FastAPI", "PostgreSQL", "Redis",
    )
    assert contract.prior_context_reask_forbidden is True
    repeated_request = validate_task_requirements(
        "Please share the system, symptoms, recent changes, error messages/logs, "
        "and what you already tried.",
        contract,
    )
    reask = next(
        check for check in repeated_request
        if check.check_type == "task_requirement_prior_context_reask"
    )
    assert reask.status == "failed"
    assert reask.reason_code == "prior_context_reasked"
    assert dict(reask.observations)["prior_context_reask_detected"] == 1
    thin = validate_task_requirements(
        "This is probably a retry issue. Add an idempotency key.", contract,
    )
    assert {check.check_type for check in thin if check.status == "failed"} == {
        "task_requirement_context_grounding",
        "task_requirement_duplicate_retry_fix",
    }
    complete = validate_task_requirements(
        "In the FastAPI, PostgreSQL, and Redis inventory flow, the failure is a "
        "duplicate retry without idempotency. First add a UNIQUE idempotency key "
        "and commit its deduplication row and stock reservation atomically in one "
        "transaction.",
        contract,
    )
    assert all(check.status == "passed" for check in complete)

    edited_context = [{
        "user": (
            "I am building an inventory API with Django, MySQL, and Valkey. "
            "The stock-reservation endpoint applies the same reservation twice "
            "after a retry."
        ),
        "assistant": "Understood.",
    }]
    edited = with_contextual_task_requirements(
        extract_task_requirements(prompt), message=prompt,
        context_turns=edited_context, use_context=True,
    )
    assert edited.contextual_stack_terms == ("Django", "MySQL", "Valkey")
    mixed = validate_task_requirements(
        "FastAPI and PostgreSQL should add an atomic UNIQUE idempotency key for "
        "the duplicate retry.", edited,
    )
    context_check = next(
        check for check in mixed
        if check.check_type == "task_requirement_context_grounding"
    )
    assert context_check.status == "failed"


def test_contextual_transaction_pseudocode_requires_prior_problem_anchor():
    prompt = "Show the transaction boundary for that fix in pseudocode."
    context = [{
        "user": (
            "I am building an inventory API with FastAPI, PostgreSQL, and Redis. "
            "The stock-reservation endpoint applies the same reservation twice "
            "after a retry."
        ),
        "assistant": "Use an idempotency key.",
    }]
    contract = with_contextual_task_requirements(
        extract_task_requirements(prompt), message=prompt,
        context_turns=context, use_context=True,
    )
    assert contract.transaction_boundary_required is True
    assert contract.pseudocode_required is True
    assert contract.contextual_stack_terms == ()
    assert "inventory" in contract.contextual_anchor_terms
    unrelated = validate_task_requirements(
        "```text\nBEGIN TRANSACTION\nCOMMIT\n```", contract,
    )
    assert next(
        check for check in unrelated
        if check.check_type == "task_requirement_context_grounding"
    ).status == "failed"
    grounded = validate_task_requirements(
        "```text\nBEGIN TRANSACTION\nINSERT inventory reservation\nCOMMIT\n```\n"
        "The FastAPI, PostgreSQL, and Redis stock flow stays atomic.",
        contract,
    )
    assert all(check.status == "passed" for check in grounded)


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
