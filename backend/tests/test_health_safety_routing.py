from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from config import MEDICAL_SAFETY_NOTE
from stage_behaviour_questions import BehaviourQuestionnaire
from stage_english_remodel import EnglishRemodeler
from stage_openai_core import OpenAICore
from app.ai.orchestrator import run_text_turn
from app.ai.intent import classify_intent_with_metadata
from app.ai.types import AIRequest
from app.database import SessionLocal


@pytest.mark.parametrize("message", [
    "What healthy habits can help me maintain my energy as I get older?",
    "How do I make a PDF smaller?",
    "What settings should I use for night photography?",
])
def test_benign_topic_questions_are_not_local_tool_routes(message: str) -> None:
    decision = classify_intent_with_metadata(message)
    assert decision.intent == "general"
    assert decision.route == "general"


@pytest.mark.parametrize("message", [
    "Is investment advice regulated in India?",
    "What happens in a lawsuit for breach of contract?",
    "Do I need legal advice to register a company?",
    "What does a blood test diagnosis involve?",
])
def test_professional_topic_questions_remain_general(message: str) -> None:
    assert classify_intent_with_metadata(message).route == "general"


class FixedCore:
    def __init__(self, answer: str) -> None:
        self.answer = answer

    def generate_text(self, *_args: Any, **_kwargs: Any) -> str:
        return self.answer


class EmptyRag:
    def retrieve(self, *_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        return []


def _remodeler(tmp_path: Path, answer: str) -> EnglishRemodeler:
    dataset_path = tmp_path / "classifier.csv"
    dataset_path.write_text(
        "\n".join(
            [
                "text,label,answer",
                "how to prepare for interviews,career,Practice common questions and update your resume.",
                "how to eat with diabetes,health,Ask your clinician for a safe food plan.",
            ]
        ),
        encoding="utf-8",
    )
    return EnglishRemodeler(FixedCore(answer), dataset_path=dataset_path)


def _profile_with_medical_notes() -> dict[str, Any]:
    return {
        "profile_summary": "User has diabetes, blood pressure concerns, and medicine reminders.",
        "profile_card": {
            "health_conditions": ["diabetes_or_sugar_control", "blood_pressure_or_heart_care"],
            "food_caution": "avoid_sugary_foods",
        },
        "behaviour_rules": [MEDICAL_SAFETY_NOTE, "For sugar-control users, avoid advice that increases sugar load."],
    }


def test_tamil_job_query_does_not_trigger_health_disclaimer_from_profile(tmp_path: Path) -> None:
    raw_answer = "Update your resume, apply consistently, and practice interviews."
    remodeler = _remodeler(tmp_path, raw_answer)

    result = remodeler.remodel_with_meta(
        "எனக்கு வேலை கிடைக்கவில்லை, நான் என்ன செய்யலாம்?",
        raw_answer,
        _profile_with_medical_notes(),
    )

    assert result["risk_level"] != "high"
    assert MEDICAL_SAFETY_NOTE not in result["answer"]


def test_english_job_query_does_not_trigger_health_disclaimer_from_profile(tmp_path: Path) -> None:
    raw_answer = "Update your resume, apply consistently, and practice interviews."
    remodeler = _remodeler(tmp_path, raw_answer)

    result = remodeler.remodel_with_meta(
        "I am not getting a job. What should I do?",
        raw_answer,
        _profile_with_medical_notes(),
    )

    assert result["risk_level"] != "high"
    assert MEDICAL_SAFETY_NOTE not in result["answer"]


def test_real_health_query_still_triggers_health_sensitive_handling(tmp_path: Path) -> None:
    raw_answer = "Call emergency services now and ask someone nearby to stay with you."
    remodeler = _remodeler(tmp_path, raw_answer)

    result = remodeler.remodel_with_meta(
        "I have chest pain and fainting. What should I do?",
        raw_answer,
        {},
    )

    assert result["risk_level"] == "high"
    assert MEDICAL_SAFETY_NOTE in result["answer"]


def test_broad_non_medical_terms_do_not_trigger_health_sensitive_routing(tmp_path: Path) -> None:
    raw_answer = "Here is a practical next step."
    remodeler = _remodeler(tmp_path, raw_answer)

    for prompt in [
        "What are customer pain points in my startup?",
        "Help me pitch my food startup",
        "My laptop sleep mode is broken",
        "Give me a Python exercise",
    ]:
        result = remodeler.remodel_with_meta(prompt, raw_answer, _profile_with_medical_notes())

        assert result["risk_level"] != "high", prompt
        assert MEDICAL_SAFETY_NOTE not in result["answer"], prompt


def test_health_sensitive_routing_ignores_contextual_non_medical_words(tmp_path: Path) -> None:
    raw_answer = "Here is a practical next step."
    remodeler = _remodeler(tmp_path, raw_answer)

    for prompt in [
        "What is the heart of this project?",
        "How to make tablet layout responsive?",
        "Give me a dose of motivation",
        "The heart icon is not centered",
    ]:
        result = remodeler.remodel_with_meta(prompt, raw_answer, _profile_with_medical_notes())

        assert result["risk_level"] != "high", prompt
        assert MEDICAL_SAFETY_NOTE not in result["answer"], prompt


def test_health_sensitive_routing_keeps_medical_contexts(tmp_path: Path) -> None:
    raw_answer = "Use cautious self-care and seek professional guidance if needed."
    remodeler = _remodeler(tmp_path, raw_answer)

    for prompt in [
        "heart attack symptoms",
        "what dose of this medicine should I take?",
        "can I take this tablet with diabetes?",
        "I have chest pain",
    ]:
        result = remodeler.remodel_with_meta(prompt, raw_answer, {})

        assert result["risk_level"] == "high", prompt
        assert MEDICAL_SAFETY_NOTE in result["answer"], prompt


def test_medical_phrase_context_still_triggers_health_sensitive_routing(tmp_path: Path) -> None:
    raw_answer = "Use cautious self-care and seek professional guidance if needed."
    remodeler = _remodeler(tmp_path, raw_answer)

    for prompt in [
        "I have stomach pain",
        "What should I eat with diabetes?",
        "Diet for blood pressure",
        "I cannot sleep for many days",
    ]:
        result = remodeler.remodel_with_meta(prompt, raw_answer, {})

        assert result["risk_level"] == "high", prompt
        assert MEDICAL_SAFETY_NOTE in result["answer"], prompt


def _base_answers() -> dict[str, Any]:
    return {
        "age_group": "26-35",
        "gender_context": "prefer_not_to_say",
        "life_stage": "none_of_these",
        "food_preference": "mixed_flexible",
        "health_conditions": ["none"],
        "food_caution": "no_special_caution",
        "sleep_pattern": "regular",
        "daily_activity": "mostly_sitting",
        "main_goal": "career_or_business",
        "communication_tone": "warm",
        "answer_length": "medium",
        "personality_style": "practical",
        "stress_support": "direct_solution",
        "family_role": "working_professional",
    }


def _derive_rules(answers: dict[str, Any]) -> dict[str, Any]:
    questionnaire = BehaviourQuestionnaire.__new__(BehaviourQuestionnaire)
    return questionnaire._derive_behaviour_rules(answers)


def test_behaviour_rules_do_not_add_medical_note_by_default() -> None:
    rules = _derive_rules(_base_answers())

    assert MEDICAL_SAFETY_NOTE not in rules["mandatory_notes"]


def test_behaviour_rules_add_medical_note_for_health_context() -> None:
    answers = _base_answers()
    answers["health_conditions"] = ["diabetes_or_sugar_control"]

    rules = _derive_rules(answers)

    assert MEDICAL_SAFETY_NOTE in rules["mandatory_notes"]
    assert "For sugar-control users, avoid advice that increases sugar load." in rules["mandatory_notes"]


def test_runtime_context_filters_stale_default_medical_note_without_health_context() -> None:
    answers = _base_answers()
    questionnaire = BehaviourQuestionnaire.__new__(BehaviourQuestionnaire)
    questionnaire.rag = EmptyRag()
    questionnaire._load_history_documents = lambda *_args, **_kwargs: []
    profile = {
        "user_id": "profile-example",
        "answers": answers,
        "behaviour_rules": {
            "preferred_tone": "warm and clear",
            "preferred_answer_length": "1-2 balanced paragraphs",
            "mandatory_notes": [MEDICAL_SAFETY_NOTE],
            "avoid_items": [],
            "avoid_topics": [],
            "health_flags": {
                "pregnant": False,
                "postpartum_or_breastfeeding": False,
                "trying_to_conceive": False,
                "diabetes_or_sugar_control": False,
                "blood_pressure_or_heart_care": False,
                "thyroid_or_hormonal_care": False,
                "allergy_digestion_kidney_or_other": False,
            },
        },
        "rag_personality_hints": {"top_traits": [], "retrieved_examples": [], "personality_summary": ""},
    }

    context = questionnaire.build_runtime_context(profile, user_query="I need help getting a job")

    assert MEDICAL_SAFETY_NOTE not in context
    assert "No special notes" in context


def test_stage_openai_core_profile_medical_context_does_not_inject_safety_for_career_query() -> None:
    core = OpenAICore.__new__(OpenAICore)
    captured: dict[str, str] = {}

    def fake_generate_json(system_prompt: str, user_prompt: str, *_args: Any, **_kwargs: Any) -> dict[str, str]:
        captured["system_prompt"] = system_prompt
        captured["user_prompt"] = user_prompt
        return {
            "answer": "Focus on one target role, update your resume, and apply consistently.",
            "answer_style": "practical",
            "risk_level": "low",
            "safety_notes": "",
        }

    core.generate_json = fake_generate_json  # type: ignore[method-assign]
    profile_context = (
        "User profile notes: diabetes, BP follow-up, and medical reminders are saved. "
        "Main goal: career_or_business."
    )

    result = core.answer_user_query_structured(
        "I am not getting a job. What should I do?",
        profile_context,
    )

    assert MEDICAL_SAFETY_NOTE not in captured["user_prompt"]
    assert result["risk_level"] == "low"
    assert result["safety_notes"] == ""
    assert MEDICAL_SAFETY_NOTE not in result["answer"]


def _ai_request(message: str) -> AIRequest:
    return AIRequest(
        user_id=1,
        message=message,
        reply_language="en",
        channel="text",
        request_id="safety-test",
        metadata={},
    )


def test_ai_router_blocks_unsafe_query_before_cache():
    def unsafe_cache(*_args):
        return {"answer": "cached unsafe answer", "answer_language": "en", "confidence": 1.0}

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _ai_request("I want to kill myself"),
            existing_context={"global_cache_lookup": unsafe_cache},
        )

    assert response.provider == "blocked"
    assert response.route == "safety_block"
    assert "cached unsafe answer" not in response.text


def test_ai_router_normal_cache_hit_still_works():
    def safe_cache(*_args):
        return {"id": 1, "answer": "A compiler translates source code.", "answer_language": "en", "confidence": 0.99}

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _ai_request("What is a compiler?"),
            existing_context={"global_cache_lookup": safe_cache},
        )

    assert response.provider == "cache"
    assert response.route == "global_knowledge_cache"
    assert response.text == "A compiler translates source code."


def test_ai_router_live_data_disabled_does_not_hallucinate(monkeypatch):
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")

    with SessionLocal() as session:
        response = run_text_turn(session, _ai_request("latest IPL score today"))

    assert response.provider == "blocked"
    assert response.route == "live_data_disabled"
    assert "cannot fetch live" in response.text.lower()
