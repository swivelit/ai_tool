from __future__ import annotations

import json

import app.main as main_module
from app.models import UserProfile


def test_partial_answers_json_is_not_questionnaire_complete() -> None:
    profile = UserProfile(
        user_id=1,
        answers_json=json.dumps({"preferred_language": "english"}),
        questions_version=2,
    )

    assert main_module._questionnaire_completed(profile) is False


def test_full_required_answers_json_is_questionnaire_complete() -> None:
    answers = {slot: "filled" for slot in main_module.REQUIRED_PROFILE_SLOTS}
    profile = UserProfile(
        user_id=1,
        answers_json=json.dumps(answers),
        questions_version=2,
    )

    assert main_module._questionnaire_completed(profile) is True


def test_empty_list_answer_is_not_questionnaire_complete() -> None:
    answers = {slot: "filled" for slot in main_module.REQUIRED_PROFILE_SLOTS}
    answers["interests"] = []
    profile = UserProfile(
        user_id=1,
        answers_json=json.dumps(answers),
        questions_version=2,
    )

    assert main_module._questionnaire_completed(profile) is False
