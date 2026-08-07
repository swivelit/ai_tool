from __future__ import annotations

import json

import pytest

from app.ai.prompts import build_provider_messages
from app.ai.types import AIRequest, AIRoute
from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.models import QualityCheck
from app.web_ai.generation.output_contract import (
    OutputContract,
    apply_reply_language_contract,
    canonicalize_output_contract,
    contract_compliant_candidate,
    extract_output_contract,
    validate_output_contract,
)
from app.web_ai.streaming_policy import select_streaming_policy
from app.web_ai.generation.repair import build_repair_request
from app.web_ai.generation.task_requirements import extract_task_requirements
from app.web_api.chat_service import (
    _cache_compatibility_hash,
    _cache_response,
    _enforce_final_output_contract_quality,
)


def test_tamil_profile_language_becomes_a_verified_script_contract():
    base = extract_output_contract("Explain gravity in one simple sentence.")
    contract = apply_reply_language_contract(base, "ta")

    assert contract.exact_sentence_count == 1
    assert contract.required_script == "tamil"
    english = validate_output_contract("Gravity pulls objects together.", contract)
    tamil = validate_output_contract("ஈர்ப்பு விசை பொருட்களை ஒன்றாக இழுக்கிறது.", contract)
    assert any(check.status == "failed" for check in english)
    assert all(check.status == "passed" for check in tamil)


B01 = (
    "Explain idempotency in payment APIs to a junior developer. Use exactly "
    "four bullet points, include one concrete retry example, and use no more "
    "than 140 words."
)
B02 = """Return exactly two fenced Python code blocks.

The first block must begin with:

# pricing.py

The second block must begin with:

# test_pricing.py

Do not return any other code block."""
C03 = """Return only valid JSON with exactly these keys:

- answer
- reason
- confidence

Do not use Markdown fences."""
C04 = (
    "Summarize this into exactly three bullets. Each bullet must contain no "
    "more than twelve words. Do not add an introduction or conclusion."
)
C06 = "Ask exactly three clarifying questions. Do not silently choose an interpretation."
C07 = "ஒளிச்சேர்க்கை எப்படி வேலை செய்கிறது? ஐந்து எளிய தமிழ் வாக்கியங்களில் விளக்கவும்."
C09 = """Write a micro-story of exactly 120 words.
Include the phrase “blue umbrella” exactly once.
End with the word “home”.
Do not include a title."""


@pytest.mark.parametrize(
    ("prompt", "expected"),
    (
        (B01, {"exact_bullet_count": 4, "max_total_words": 140}),
        (B02, {"exact_fenced_block_count": 2, "fenced_language": "python"}),
        (C03, {"json_only": True, "exact_json_keys": ("answer", "reason", "confidence")}),
        (C04, {"exact_bullet_count": 3, "max_words_per_bullet": 12}),
        (C06, {"exact_question_count": 3}),
        (C07, {"exact_sentence_count": 5, "required_script": "tamil"}),
        (C09, {"exact_word_count": 120, "required_final_word": "home"}),
    ),
)
def test_extracts_typed_output_contracts(prompt, expected):
    contract = extract_output_contract(prompt)
    assert contract.required
    for key, value in expected.items():
        assert getattr(contract, key) == value


def test_strict_contract_reserves_visible_output_without_global_reasoning_change():
    story = extract_output_contract(C09)
    assert story.strict_visible_format is True
    assert 200 <= story.minimum_visible_output_tokens <= 420
    assert OutputContract().minimum_visible_output_tokens == 0


def test_bullet_and_json_contracts_validate_deterministically():
    bullets = "\n".join(f"- concise item {index}" for index in range(1, 5))
    assert all(check.status == "passed" for check in validate_output_contract(
        bullets, extract_output_contract(B01)
    ))
    failed = validate_output_contract("- only one", extract_output_contract(B01))
    assert any(check.status == "failed" for check in failed)

    valid_json = json.dumps({"answer": True, "reason": "prime", "confidence": 1})
    assert all(check.status == "passed" for check in validate_output_contract(
        valid_json, extract_output_contract(C03)
    ))
    invalid = validate_output_contract(
        f"Here: {valid_json}", extract_output_contract(C03)
    )
    assert {check.reason_code for check in invalid if check.status == "failed"} == {
        "json_only_failed", "exact_json_keys_failed",
    }


def test_fence_count_language_and_prefixes_are_mandatory():
    contract = extract_output_contract(B02)
    correct = "```python\n# pricing.py\npass\n```\n```python\n# test_pricing.py\npass\n```"
    assert all(check.status == "passed" for check in validate_output_contract(
        correct, contract
    ))
    wrong = correct + "\n```python\n# unexpected.py\n```"
    assert any(
        check.reason_code == "exact_fence_count_failed"
        for check in validate_output_contract(wrong, contract)
    )


def test_safe_canonicalization_removes_json_and_fence_wrappers_only():
    json_contract = extract_output_contract(C03)
    wrapped = (
        'Result follows:\n```json\n'
        '{"answer":true,"reason":"prime","confidence":1}\n```'
    )
    canonical_json = canonicalize_output_contract(wrapped, json_contract)
    assert json.loads(canonical_json) == {
        "answer": True, "reason": "prime", "confidence": 1,
    }
    assert all(
        item.status == "passed"
        for item in validate_output_contract(canonical_json, json_contract)
    )

    fence_contract = extract_output_contract(B02)
    answer = (
        "Intro\n```python\n# pricing.py\npass\n```\n"
        "```python\n# test_pricing.py\npass\n```\n"
        "```python\n# unrelated.py\npass\n```\nOutro"
    )
    canonical_fences = canonicalize_output_contract(answer, fence_contract)
    assert canonical_fences.count("```python") == 2
    assert "unrelated.py" not in canonical_fences
    assert all(
        item.status == "passed"
        for item in validate_output_contract(canonical_fences, fence_contract)
    )


def test_sentence_question_story_and_no_title_contracts():
    assert all(check.status == "passed" for check in validate_output_contract(
        "ஒன்று. இரண்டு. மூன்று. நான்கு. ஐந்து.", extract_output_contract(C07)
    ))
    assert all(check.status == "passed" for check in validate_output_contract(
        "First? Second? Third?", extract_output_contract(C06)
    ))
    story = " ".join(["blue", "umbrella"] + ["path"] * 117 + ["home"])
    assert len(story.split()) == 120
    assert all(check.status == "passed" for check in validate_output_contract(
        story, extract_output_contract(C09)
    ))


def test_exact_word_count_records_bounded_repair_observations():
    contract = extract_output_contract(C09)
    value = " ".join(["word"] * 111)
    check = next(
        item for item in validate_output_contract(value, contract)
        if item.check_type == "output_contract_word_count"
    )
    assert check.status == "failed"
    assert dict(check.observations) == {
        "expected_word_count": 120,
        "observed_word_count": 111,
        "word_count_delta": -9,
    }


def test_tamil_script_is_a_first_class_mandatory_contract():
    tamil_contract = extract_output_contract(
        "Explain photosynthesis in exactly five Tamil sentences."
    )
    assert tamil_contract.required_script == "tamil"
    non_tamil = validate_output_contract(
        "One. Two. Three. Four. Five.", tamil_contract
    )
    script_check = next(
        check for check in non_tamil
        if check.check_type == "output_contract_required_script"
    )
    assert script_check.status == "failed"
    assert dict(script_check.observations) == {
        "contains_tamil_script": 0,
        "validator_version": "2026-08-03.1",
    }

    tamil = "ஒன்று. இரண்டு. மூன்று. நான்கு. ஐந்து."
    checks = validate_output_contract(tamil, tamil_contract)
    assert all(check.status == "passed" for check in checks)
    sentence_check = next(
        check for check in checks
        if check.check_type == "output_contract_sentence_count"
    )
    assert dict(sentence_check.observations)["observed_sentence_count"] == 5


def test_tamil_wording_adds_the_same_script_contract():
    contract = extract_output_contract(C07)
    assert contract.exact_sentence_count == 5
    assert contract.required_script == "tamil"


def test_failed_mandatory_contract_is_unverified_and_telemetred():
    contract = extract_output_contract(B01)
    result = AnswerGuard().check(
        "One paragraph instead of bullets.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract=B01,
            verified_buffered=True,
            output_contract=contract,
        ),
    )
    assert result.status == "unverified"
    assert any(
        check.check_type == "output_contract_bullet_count"
        and check.status == "failed"
        for check in result.checks
    )


def test_contract_is_in_frozen_provider_prompt_and_requires_buffering():
    contract = extract_output_contract(C03)
    request = AIRequest(
        user_id=1,
        message=C03,
        reply_language="en",
        channel="text",
        request_id="contract-test",
        metadata={"client_surface": "web", "output_contract": contract.as_metadata()},
    )
    route = AIRoute(
        provider="openai", model="test", route="general", reason="test",
        language="en", intent="general", max_output_tokens=200,
    )
    messages = build_provider_messages(request, route, provider="openai")
    assert "Mandatory output contract" in "\n".join(item["content"] for item in messages)
    policy = select_streaming_policy(
        answer_guard_enabled=True,
        verified_streaming_enabled=False,
        has_evidence=False,
        answer_class="normal",
        max_buffer_characters=200_000,
        output_contract_required=True,
    )
    assert policy.mode == "verified_buffered"
    ordinary = select_streaming_policy(
        answer_guard_enabled=True,
        verified_streaming_enabled=True,
        has_evidence=False,
        answer_class="normal",
        max_buffer_characters=200_000,
    )
    assert ordinary.mode == "direct"
    contextual_requirement = select_streaming_policy(
        answer_guard_enabled=True,
        verified_streaming_enabled=False,
        has_evidence=False,
        answer_class="normal",
        max_buffer_characters=200_000,
        task_requirements_required=True,
    )
    assert contextual_requirement.mode == "verified_buffered"


def test_metadata_parser_rejects_untyped_values():
    contract = OutputContract.from_metadata({
        "exact_word_count": "120",
        "json_only": "true",
        "unknown": "ignored",
    })
    assert not contract.required


def test_old_cached_prose_cannot_satisfy_json_only_contract(monkeypatch):
    observed = {}

    def lookup(*args, **kwargs):
        observed.update(kwargs)
        return {
            "answer": 'The answer is {"answer":true,"reason":"prime"}.',
            "answer_language": "en",
        }

    monkeypatch.setenv("WEB_CACHE_BEFORE_BILLING_ENABLED", "true")
    monkeypatch.setattr(
        "app.global_qa_cache.lookup_approved_global_cache", lookup
    )
    monkeypatch.setattr(
        "app.global_qa_cache.token_hash_embedding_for_global_cache",
        lambda _message: ([0.1], 0.1, "token_hash_v1"),
    )

    response = _cache_response(
        1,
        C03,
        "en",
        output_contract=extract_output_contract(C03),
        answer_class="normal",
        cache_compatibility_hash="compatibility-test",
    )

    assert response is None
    assert observed["exact_only"] is True
    assert observed["cache_compatibility_hash"] == "compatibility-test"


def test_detailed_and_long_form_cache_lookups_are_exact_only(monkeypatch):
    observed: list[bool] = []

    def lookup(*args, **kwargs):
        observed.append(kwargs["exact_only"])
        return None

    monkeypatch.setenv("WEB_CACHE_BEFORE_BILLING_ENABLED", "true")
    monkeypatch.setattr(
        "app.global_qa_cache.lookup_approved_global_cache", lookup
    )
    monkeypatch.setattr(
        "app.global_qa_cache.token_hash_embedding_for_global_cache",
        lambda _message: ([0.1], 0.1, "token_hash_v1"),
    )
    for answer_class in ("detailed", "long_form"):
        assert _cache_response(
            1,
            "A unique architecture question",
            "en",
            output_contract=OutputContract(),
            answer_class=answer_class,
            cache_compatibility_hash="compatible",
        ) is None

    assert observed == [True, True]


def test_cache_compatibility_changes_with_prompt_policy_and_contract():
    plain = OutputContract()
    constrained = extract_output_contract(C03)
    baseline = _cache_compatibility_hash(
        prompt_schema_version="prompt-v1",
        policy_version="policy-v1",
        output_contract=plain,
    )
    variants = {
        _cache_compatibility_hash(
            prompt_schema_version="prompt-v2",
            policy_version="policy-v1",
            output_contract=plain,
        ),
        _cache_compatibility_hash(
            prompt_schema_version="prompt-v1",
            policy_version="policy-v2",
            output_contract=plain,
        ),
        _cache_compatibility_hash(
            prompt_schema_version="prompt-v1",
            policy_version="policy-v1",
            output_contract=constrained,
        ),
    }
    assert baseline not in variants
    assert len(variants) == 3


def test_repair_prompt_contains_the_exact_typed_contract_and_no_commentary_rule():
    contract = extract_output_contract(C03)
    repair = build_repair_request(
        user_id=1,
        request_id="contract-repair",
        reply_language="en",
        current_answer="Answer: yes",
        failed_checks=(QualityCheck(
            "output_contract_json_only", "failed", "json_only_failed"
        ),),
        evidence_pack=None,
        task_contract=C03,
        output_contract=contract,
    )
    messages = repair.request.metadata["provider_messages"]
    rendered = "\n".join(str(item["content"]) for item in messages)
    assert "Return only the repaired final answer" in rendered
    assert "Use exactly these JSON keys: answer, reason, confidence" in rendered
    assert repair.request.metadata["output_contract"] == contract.as_metadata()


def test_second_exact_count_repair_is_strict_bounded_and_observation_aware():
    contract = extract_output_contract(C09)
    failed = next(
        item for item in validate_output_contract(" ".join(["word"] * 111), contract)
        if item.check_type == "output_contract_word_count"
    )
    repair = build_repair_request(
        user_id=1,
        request_id="exact-count-repair",
        reply_language="en",
        current_answer=" ".join(["word"] * 111),
        failed_checks=(failed,),
        evidence_pack=None,
        task_contract=C09,
        output_contract=contract,
        attempt_number=2,
        strict_format_correction=True,
    )
    rendered = "\n".join(
        str(item["content"])
        for item in repair.request.metadata["provider_messages"]
    )
    assert repair.request.request_id == "exact-count-repair:repair:2"
    assert repair.request.metadata["strict_output_contract"] is True
    assert repair.request.metadata["minimum_visible_output_tokens"] >= 200
    assert repair.request.metadata["max_provider_attempts"] == 1
    assert "observed_word_count=111" in rendered
    assert "word_count_delta=-9" in rendered
    assert "draft is 111 words; the contract requires exactly 120" in rendered
    assert "Add exactly 9 words" in rendered
    assert "required phrase and occurrence count" in rendered
    assert "smallest possible edit" in rendered
    assert "whitespace-delimited rule" in rendered
    assert repair.request.metadata["reasoning_effort_override"] == "low"
    assert repair.request.metadata["repair_reasoning"] is True


@pytest.mark.parametrize(
    ("prompt", "check", "required_text"),
    (
        (
            "Explain idempotency in payment APIs and include one concrete retry example.",
            QualityCheck(
                "task_requirement_example", "failed", "concrete_example_missing",
                observations=(
                    ("definition_present", 1),
                    ("concrete_retry_example_present", 0),
                    ("stable_outcome_present", 1),
                ),
            ),
            "Include a concrete retry example showing the retry in action",
        ),
        (
            "Compare Policy Alpha and Policy Beta retention.",
            QualityCheck(
                "task_requirement_comparison", "failed", "named_comparison_missing",
            ),
            "Explicitly compare every requested named alternative",
        ),
        (
            "Explain idempotency in payment APIs and include one concrete retry example.",
            QualityCheck(
                "task_requirement_stable_outcome",
                "failed",
                "stable_idempotent_outcome_missing",
                observations=(
                    ("definition_present", 1),
                    ("concrete_retry_example_present", 1),
                    ("stable_outcome_present", 0),
                ),
            ),
            "Use explicit one-operation/one-side-effect wording",
        ),
        (
            "Design a webhook architecture and include transaction boundaries.",
            QualityCheck(
                "task_architecture_transaction_boundaries",
                "failed",
                "architecture_area_missing",
                observations=(("area_identifier", "transaction_boundaries"),),
            ),
            "Replace the transaction-boundaries section with one explicit atomic transaction",
        ),
    ),
)
def test_repair_prompt_names_the_specific_missing_semantic_element(
    prompt: str,
    check: QualityCheck,
    required_text: str,
):
    requirements = extract_task_requirements(prompt)
    repair = build_repair_request(
        user_id=1,
        request_id="semantic-repair",
        reply_language="en",
        current_answer="Incomplete draft.",
        failed_checks=(check,),
        evidence_pack=None,
        task_contract=prompt,
        task_requirements=requirements,
    )
    rendered = "\n".join(
        str(item["content"])
        for item in repair.request.metadata["provider_messages"]
    )

    assert "Targeted corrections:" in rendered
    assert required_text in rendered
    assert check.check_type in rendered
    assert "Current answer (bounded context):\nIncomplete draft." in rendered
    if check.check_type == "task_requirement_example":
        assert "concrete_retry_example_present=0" in rendered
    if check.check_type == "task_requirement_stable_outcome":
        assert "stable_outcome_present=0" in rendered
        assert "exactly one charge or record" in rendered
        assert "no second balance change" in rendered
        assert "modify an existing bullet rather than adding a bullet" in rendered
    if check.check_type == "task_architecture_transaction_boundaries":
        assert "SELECT ... FOR UPDATE" in rendered
        assert "commit boundary plus rollback" in rendered


def test_last_mile_contract_guard_cannot_persist_invalid_text_as_verified():
    contract = extract_output_contract(B01)
    claimed = AnswerGuard().check(
        "- one\n- two\n- three\n- four",
        AnswerGuardContext(
            answer_class="normal",
            task_contract=B01,
            verified_buffered=True,
            output_contract=contract,
        ),
    )
    assert claimed.status == "verified"

    enforced = _enforce_final_output_contract_quality(
        "One paragraph that violates the contract.", contract, claimed
    )
    assert enforced is not None
    assert enforced.status == "unverified"
    assert any(
        check.check_type == "output_contract_bullet_count"
        and check.status == "failed"
        for check in enforced.checks
    )


@pytest.mark.parametrize(
    ("prompt", "candidate"),
    [
        (C03, "Paste the JSON you want me to validate."),
        (B01, "A deterministic paragraph without bullet markers."),
        (B02, "```python\n# pricing.py\npass\n```"),
    ],
)
def test_contract_invalid_deterministic_candidates_are_rejected(prompt, candidate):
    assert contract_compliant_candidate(
        candidate, extract_output_contract(prompt)
    ) is None


def test_contract_compliant_deterministic_json_candidate_is_allowed():
    contract = extract_output_contract(C03)
    candidate = '{"answer":true,"reason":"divisors","confidence":1}'
    assert contract_compliant_candidate(candidate, contract) == candidate
