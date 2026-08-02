from __future__ import annotations

import json

import pytest

from app.ai.prompts import build_provider_messages
from app.ai.types import AIRequest, AIRoute
from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.output_contract import (
    OutputContract,
    extract_output_contract,
    validate_output_contract,
)
from app.web_ai.streaming_policy import select_streaming_policy


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
        (C07, {"exact_sentence_count": 5}),
        (C09, {"exact_word_count": 120, "required_final_word": "home"}),
    ),
)
def test_extracts_typed_output_contracts(prompt, expected):
    contract = extract_output_contract(prompt)
    assert contract.required
    for key, value in expected.items():
        assert getattr(contract, key) == value


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


def test_metadata_parser_rejects_untyped_values():
    contract = OutputContract.from_metadata({
        "exact_word_count": "120",
        "json_only": "true",
        "unknown": "ignored",
    })
    assert not contract.required
