from __future__ import annotations

import pytest

from app.web_api.conversation_continuity import (
    decide_same_thread_continuity,
    normalize_same_thread_context_mode,
)
from app.ai.intent import classify_contextual_followup


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


def test_named_standalone_subject_wins_before_lexical_overlap():
    previous = [{
        "user": "Explain FastAPI dependency injection.",
        "assistant": "FastAPI resolves dependencies per request.",
    }]
    decision = decide_same_thread_continuity(
        "How would I test FastAPI dependencies?", previous, mode="adaptive",
    )
    assert decision.use_context is False
    assert decision.reason == "clear_standalone_subject"


def test_missing_application_subject_uses_context():
    previous = [{
        "user": "Design a FastAPI authentication service.",
        "assistant": "Use a layered service.",
    }]
    decision = decide_same_thread_continuity(
        "How do I add refresh tokens?", previous, mode="adaptive",
    )
    assert decision.use_context is True
    assert decision.reason == "missing_application_subject"


def test_inventory_failure_mode_followup_does_not_depend_on_generic_overlap():
    history = [{
        "user": (
            "I am building an inventory API with FastAPI, PostgreSQL, and Redis. "
            "The stock-reservation endpoint occasionally applies the same "
            "reservation twice after a client retry."
        ),
        "assistant": "The likely cause can be diagnosed from those details.",
    }]
    decision = decide_same_thread_continuity(
        "What is the most likely failure mode, and what should I change first?",
        history,
        mode="adaptive",
    )
    assert decision.use_context is True
    assert decision.reason != "lexical_topic_overlap"


def test_named_unrelated_subject_omits_inventory_context():
    history = [{
        "user": "I am building an inventory API with FastAPI and PostgreSQL.",
        "assistant": "Understood.",
    }]
    decision = decide_same_thread_continuity(
        "What is the capital of France?", history, mode="adaptive",
    )
    assert decision.use_context is False
    assert decision.reason == "clear_standalone_subject"


@pytest.mark.parametrize(
    "message",
    [
        "Show the transaction boundary for that fix in pseudocode.",
        "Compare that approach with using a distributed lock.",
        "Explain that fix more simply.",
    ],
)
def test_explicit_inventory_followups_keep_context(message):
    decision = decide_same_thread_continuity(message, HISTORY, mode="adaptive")
    assert decision.use_context is True
    assert decision.reason in {"explicit_followup", "referential_language"}


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


OFFICEHOLDER_HISTORY = [{
    "user": "Who is the CM of Tamil Nadu?",
    "assistant": "Example Person is the Chief Minister of Tamil Nadu.",
}]


@pytest.mark.parametrize(
    "message",
    [
        "Write a Python sorting function.",
        "Capital of France?",
        "What is a binary tree and how does it work?",
        "Explain this Python code: print(2 + 2)",
        "What is the first option in Python argparse?",
        "chief minister of Kerala",
        "கிரிக்கெட் என்றால் என்ன?",
        "python code kudu",
        "New topic: explain Python and how it works.",
    ],
)
def test_adaptive_independent_subjects_do_not_reuse_officeholder_history(message):
    decision = decide_same_thread_continuity(
        message, OFFICEHOLDER_HISTORY, mode="adaptive",
    )
    assert decision.use_context is False


@pytest.mark.parametrize(
    "message",
    [
        "Explain this Python code: print(2 + 2)",
        "What is the first option in Python argparse?",
    ],
)
def test_explicit_only_does_not_transform_a_subject_bound_reference(message):
    assert classify_contextual_followup(message) is None
    decision = decide_same_thread_continuity(
        message, OFFICEHOLDER_HISTORY, mode="explicit_only",
    )
    assert decision.use_context is False


def test_omitted_role_entity_switch_still_uses_context():
    decision = decide_same_thread_continuity(
        "What about Kerala?", OFFICEHOLDER_HISTORY, mode="adaptive",
    )
    assert decision.use_context is True


def test_unresolved_person_pronoun_does_not_use_unrelated_history():
    decision = decide_same_thread_continuity(
        "How old is he?", [{
            "user": "What is Python?",
            "assistant": "Python is a programming language.",
        }], mode="adaptive",
    )
    assert decision.use_context is False


def test_person_pronoun_keeps_a_matching_person_antecedent():
    history = [{
        "user": "Who is Example Person?",
        "assistant": "Example Person is a researcher.",
    }]
    assert decide_same_thread_continuity(
        "How old is he?", history, mode="adaptive",
    ).use_context is True
