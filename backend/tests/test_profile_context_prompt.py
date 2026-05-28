import json

from app.database import SessionLocal
from app.main import (
    STARTER_PROFILE_REQUIRED_SLOTS,
    _questionnaire_completed,
    _profile_prompt_context_text,
    build_profile_prompt_context,
    sanitize_client_context,
)
from app.models import UserProfile
from conftest import create_test_user


def test_profile_prompt_context_includes_summary_and_onboarding_answers():
    user = create_test_user(name="Hari")
    answers = {
        "communication_tone": "direct and practical",
        "answer_length": "short",
        "tamil_style": "chennai_conversational",
        "goals": ["ship the mobile app"],
    }
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(user.id),
                answers_json=json.dumps(answers),
                profile_summary="Chennai-based founder building a voice-first assistant.",
                questions_version=1,
            )
        )
        session.commit()

        context = build_profile_prompt_context(session, int(user.id))
        text = _profile_prompt_context_text(context)

    assert context["user"]["name"] == "Hari"
    assert context["user"]["reply_language"] == "en"
    assert context["profile_summary"] == "Chennai-based founder building a voice-first assistant."
    assert context["communication_tone"] == "direct and practical"
    assert context["answer_length"] == "short"
    assert context["tamil_style"] == "chennai_conversational"
    assert context["onboarding_answers"]["goals"] == ["ship the mobile app"]
    assert "Saved user profile" not in text
    assert "Chennai-based founder" in text


def test_profile_prompt_context_redacts_secret_and_auth_like_answer_fields():
    user = create_test_user()
    answers = {
        "preferred_topics": ["coding"],
        "api_key": "sk-should-not-leak",
        "auth_token": "bearer should-not-leak",
        "password_hint": "secret",
        "email": "private@example.com",
    }
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(user.id),
                answers_json=json.dumps(answers),
                profile_summary="Likes concise coding answers.",
                questions_version=1,
            )
        )
        session.commit()

        text = _profile_prompt_context_text(build_profile_prompt_context(session, int(user.id)))

    assert "preferred_topics" in text
    assert "sk-should-not-leak" not in text
    assert "bearer should-not-leak" not in text
    assert "private@example.com" not in text
    assert "password_hint" not in text


def test_profile_prompt_context_includes_age_group_only_when_answered():
    user = create_test_user(name="Hari")
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(user.id),
                answers_json=json.dumps({"communication_tone": "direct"}),
                profile_summary="Likes short answers.",
                questions_version=1,
            )
        )
        session.commit()
        context = build_profile_prompt_context(session, int(user.id))
    assert "age_group" not in context

    user_with_age = create_test_user(uid="teen-uid", email="teen@example.com", name="Teen")
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(user_with_age.id),
                answers_json=json.dumps({"age_group": "13_17"}),
                profile_summary="Student profile.",
                questions_version=1,
            )
        )
        session.commit()
        context = build_profile_prompt_context(session, int(user_with_age.id))

    assert context["age_group"] == "13_17"
    assert "minor" in context["age_safety_note"]


def test_profile_prompt_context_normalizes_legacy_age_group_values():
    user = create_test_user(uid="legacy-age-uid", email="legacy-age@example.com", name="Legacy")
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(user.id),
                answers_json=json.dumps({"age_group": "26-35"}),
                profile_summary="Adult profile.",
                questions_version=1,
            )
        )
        session.commit()
        context = build_profile_prompt_context(session, int(user.id))
    assert context["age_group"] == "26_35"

    senior = create_test_user(uid="senior-age-uid", email="senior-age@example.com", name="Senior")
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(senior.id),
                answers_json=json.dumps({"age_group": "60+"}),
                profile_summary="Senior profile.",
                questions_version=1,
            )
        )
        session.commit()
        context = build_profile_prompt_context(session, int(senior.id))
    assert context["age_group"] == "60_plus"


def test_client_life_context_sanitizer_redacts_sensitive_fields_and_hidden_app_names():
    sanitized = sanitize_client_context(
        {
            "life_context": {
                "enabled": True,
                "date": "2026-05-28",
                "shareAppNamesWithAi": False,
                "movementSummary": "7,420 steps, about 5.7 km",
                "screenSummary": "3.5 hours from foreground usage",
                "api_key": "sk-secret",
                "raw": {
                    "date": "2026-05-28",
                    "timezone": "Asia/Kolkata",
                    "permissions": {
                        "activityRecognition": "granted",
                        "usageAccess": "granted",
                    },
                    "movement": {
                        "steps": 7420,
                        "estimatedDistanceMeters": 5650,
                        "confidence": "high",
                        "source": "e2e_mock",
                    },
                    "screen": {
                        "screenTimeMs": 12600000,
                        "confidence": "high",
                        "source": "e2e_mock",
                    },
                    "apps": [
                        {
                            "packageName": "com.openai.chatgpt",
                            "appName": "ChatGPT",
                            "category": "productivity",
                            "foregroundTimeMs": 4200000,
                        }
                    ],
                    "firebaseUid": "uid-secret",
                    "generatedAt": "2026-05-28T00:00:00Z",
                },
            }
        }
    )
    dumped = json.dumps(sanitized)
    assert sanitized["life_context"]["raw"]["movement"]["steps"] == 7420
    assert "topAppsSummary" in sanitized["life_context"]
    assert "lifeInsightSummary" in sanitized["life_context"]
    assert "productivity" in sanitized["life_context"]["topAppsSummary"]
    assert "ChatGPT" not in dumped
    assert "com.openai.chatgpt" not in dumped
    assert "sk-secret" not in dumped
    assert "uid-secret" not in dumped


def test_client_life_context_disabled_is_dropped():
    assert sanitize_client_context({"life_context": {"enabled": False, "date": "2026-05-28"}}) == {}


def test_client_life_context_hidden_app_names_reconstructs_category_summaries():
    sanitized = sanitize_client_context(
        {
            "life_context": {
                "enabled": True,
                "date": "2026-05-28",
                "shareAppNamesWithAi": False,
                "topAppsSummary": "Top apps: ChatGPT 1 hour, YouTube 40 minutes",
                "lifeInsightSummary": "ChatGPT and WhatsApp were used most. token=sk-secret",
                "raw": {
                    "apps": [
                        {
                            "packageName": "com.openai.chatgpt",
                            "appName": "ChatGPT",
                            "category": "productivity",
                            "foregroundTimeMs": 4200000,
                        },
                        {
                            "packageName": "com.google.android.youtube",
                            "appName": "YouTube",
                            "category": "video",
                            "foregroundTimeMs": 2400000,
                        },
                    ],
                    "authId": "auth-secret",
                    "firebaseUid": "uid-secret",
                },
            }
        }
    )
    life_context = sanitized["life_context"]
    dumped = json.dumps(life_context)
    assert life_context["topAppsSummary"] == "Top apps: productivity 1.2 hours, video 40 minutes (mostly productivity)"
    assert life_context["lifeInsightSummary"] == life_context["topAppsSummary"]
    assert "ChatGPT" not in dumped
    assert "YouTube" not in dumped
    assert "WhatsApp" not in dumped
    assert "com.openai.chatgpt" not in dumped
    assert "sk-secret" not in dumped
    assert "auth-secret" not in dumped
    assert "uid-secret" not in dumped


def test_client_life_context_preserves_app_names_only_when_enabled_but_redacts_secrets():
    sanitized = sanitize_client_context(
        {
            "life_context": {
                "enabled": True,
                "date": "2026-05-28",
                "shareAppNamesWithAi": True,
                "topAppsSummary": "Top apps: ChatGPT 1 hour. Email private@example.com token sk-secret",
                "lifeInsightSummary": "ChatGPT helped. firebase uid abcdef1234567890abcdef1234567890",
                "raw": {
                    "apps": [
                        {
                            "packageName": "com.openai.chatgpt",
                            "appName": "ChatGPT",
                            "category": "productivity",
                            "foregroundTimeMs": 3600000,
                        }
                    ],
                    "api_key": "sk-secret",
                },
            }
        }
    )
    dumped = json.dumps(sanitized)
    assert "ChatGPT" in dumped
    assert "com.openai.chatgpt" in dumped
    assert "private@example.com" not in dumped
    assert "sk-secret" not in dumped
    assert "abcdef1234567890abcdef1234567890" not in dumped


def test_questionnaire_completed_uses_starter_required_slots_only():
    answers = {
        "preferred_language": "english",
        "age_group": "26_35",
        "occupation": "working_professional",
        "communication_tone": "short_direct",
        "answer_length": "short",
        "assistant_persona": "coach",
        "main_goal": "career_growth",
        "dislikes": ["too_many_questions"],
    }
    profile = UserProfile(
        user_id=9901,
        answers_json=json.dumps(answers),
        questions_version=1,
    )

    assert STARTER_PROFILE_REQUIRED_SLOTS == set(answers.keys())
    assert _questionnaire_completed(profile) is True


def test_questionnaire_completed_rejects_missing_starter_slot():
    answers = {
        "preferred_language": "english",
        "age_group": "26_35",
        "occupation": "working_professional",
        "communication_tone": "short_direct",
        "answer_length": "short",
        "assistant_persona": "coach",
        "main_goal": "career_growth",
    }
    profile = UserProfile(
        user_id=9902,
        answers_json=json.dumps(answers),
        questions_version=1,
    )

    assert _questionnaire_completed(profile) is False


def test_questionnaire_completed_accepts_existing_full_profiles():
    answers = {
        "preferred_language": "english",
        "secondary_language": "tamil",
        "age_group": "26_35",
        "occupation": "working_professional",
        "industry_or_field": "technology",
        "hobbies": ["music"],
        "interests": ["ai_technology"],
        "communication_tone": "short_direct",
        "answer_length": "short",
        "personality_style": "practical",
        "assistant_persona": "coach",
        "planning_style": "light_structure",
        "learning_style": "step_by_step",
        "main_goal": "career_growth",
        "dislikes": ["too_generic"],
        "work_rhythm": "evening",
    }
    profile = UserProfile(
        user_id=9903,
        answers_json=json.dumps(answers),
        questions_version=1,
    )

    assert _questionnaire_completed(profile) is True
