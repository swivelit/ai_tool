from __future__ import annotations

import pytest

from app.web_api.conversation_continuity import (
    decide_same_thread_continuity,
    normalize_same_thread_context_mode,
)


HISTORY = [{
    "user": "Design a FastAPI JWT authentication API.",
    "assistant": (
        "Use FastAPI dependencies, PostgreSQL, JWT access tokens, refresh tokens, "
        "rotation, and tests for the authentication service."
    ),
}]


@pytest.mark.parametrize(
    "message",
    [
        "Explain that more simply.",
        "How do I implement it?",
        "What are its advantages?",
        "Can you test that?",
        "Expand that section.",
        "Why?",
        "What next?",
        "Give me an example.",
        "What about scaling?",
        "Show phase 1.",
        "What should I learn next?",
    ],
)
def test_adaptive_english_followups_use_context(message):
    decision = decide_same_thread_continuity(message, HISTORY, mode="adaptive")
    assert decision.use_context is True
    assert decision.preferred_turn_count in {1, 2}


@pytest.mark.parametrize(
    "message",
    [
        "அதை இன்னும் சுலபமாக சொல்லு",
        "அடுத்தது என்ன?",
        "இதுக்கு example கொடு",
        "idha eppadi implement panradhu?",
        "adutha step enna?",
    ],
)
def test_adaptive_tamil_and_tanglish_followups_use_context(message):
    assert decide_same_thread_continuity(message, HISTORY, mode="adaptive").use_context


@pytest.mark.parametrize(
    ("previous", "current"),
    [
        (
            [{"user": "Explain FastAPI dependency injection.", "assistant": "FastAPI resolves dependencies per request."}],
            "How would I test FastAPI dependencies?",
        ),
        (
            [{"user": "Design a FastAPI authentication service.", "assistant": "Use a layered service."}],
            "How do I add refresh tokens?",
        ),
    ],
)
def test_overlap_and_missing_application_subject_use_context(previous, current):
    assert decide_same_thread_continuity(current, previous, mode="adaptive").use_context


@pytest.mark.parametrize(
    "message",
    [
        "What is photosynthesis?",
        "Define the French Revolution.",
        "What is Docker?",
        "How do I bake sourdough bread?",
    ],
)
def test_clear_unrelated_subject_omits_context(message):
    assert not decide_same_thread_continuity(message, HISTORY, mode="adaptive").use_context


@pytest.mark.parametrize(
    "message",
    [
        "New topic: explain cricket.",
        "Ignore the previous answer. What is Docker?",
        "வேறு கேள்வி: கிரிக்கெட் என்றால் என்ன?",
        "vera question: what is Docker?",
    ],
)
def test_explicit_topic_reset_omits_context(message):
    decision = decide_same_thread_continuity(message, HISTORY, mode="adaptive")
    assert decision.use_context is False
    assert decision.reason == "explicit_topic_reset"


def test_modes_first_message_and_invalid_value_are_safe():
    assert not decide_same_thread_continuity("Why?", [], mode="adaptive").use_context
    assert not decide_same_thread_continuity("Why?", HISTORY, mode="off").use_context
    assert not decide_same_thread_continuity("Why?", HISTORY, mode="explicit_only").use_context
    assert decide_same_thread_continuity("Why?", HISTORY, mode="always_last").use_context
    assert normalize_same_thread_context_mode("invalid") == "explicit_only"
    invalid = decide_same_thread_continuity("Why?", HISTORY, mode="invalid")
    assert invalid.mode == "explicit_only"
    assert invalid.use_context is False


def test_numbered_continuation_may_select_two_turns():
    decision = decide_same_thread_continuity("Now show phase 1.", HISTORY, mode="adaptive")
    assert decision.use_context is True
    assert decision.preferred_turn_count == 2


def test_unicode_tamil_lexical_overlap_is_contextual():
    history = [{
        "user": "PostgreSQL தரவுத்தளம் indexing பற்றி விளக்கு",
        "assistant": "தரவுத்தளம் index query வேகத்தை மேம்படுத்தும்.",
    }]
    decision = decide_same_thread_continuity(
        "தரவுத்தளம் scaling எப்படி இருக்கும்?", history, mode="adaptive"
    )
    assert decision.use_context is True
    assert decision.reason == "lexical_topic_overlap"
