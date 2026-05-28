import json

from app.database import SessionLocal
from app.main import (
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
    assert "ChatGPT" not in dumped
    assert "com.openai.chatgpt" not in dumped
    assert "sk-secret" not in dumped
    assert "uid-secret" not in dumped
