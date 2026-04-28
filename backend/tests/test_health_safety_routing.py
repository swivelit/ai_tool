from __future__ import annotations

from pathlib import Path
from typing import Any

from config import MEDICAL_SAFETY_NOTE
from stage_behaviour_questions import BehaviourQuestionnaire
from stage_english_remodel import EnglishRemodeler


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
