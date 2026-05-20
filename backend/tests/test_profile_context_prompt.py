import json

from app.database import SessionLocal
from app.main import _profile_prompt_context_text, build_profile_prompt_context
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
