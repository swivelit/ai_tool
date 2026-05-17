from sqlmodel import select

from app.ai.orchestrator import run_text_turn
from app.ai.types import AIRequest
from app.database import SessionLocal
from app.models import DailyRoutine, Item, UserProfile
from conftest import auth_headers, create_test_user


class _ExplodingProvider:
    def complete(self, *_args, **_kwargs):
        raise AssertionError("backend tool route must not call providers")


def _request(message: str, user_id: int) -> AIRequest:
    return AIRequest(
        user_id=user_id,
        message=message,
        reply_language="en",
        channel="text",
        request_id="tool-test",
        metadata={},
    )


def test_clear_reminder_creates_reminder_item_through_chat_contract(client, monkeypatch):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    user = create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "Remind me to call mom tomorrow morning", "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert set(payload.keys()) == {"ok", "item", "assistant", "pipeline", "meta"}
    assert payload["item"]["intent"] == "reminder"
    assert payload["item"]["category"] == "Reminder"
    assert payload["item"]["title"] == "call mom"
    assert payload["item"]["datetime"]
    assert "Reminder saved" in payload["assistant"]["text"]

    with SessionLocal() as session:
        stored = session.exec(select(Item).where(Item.user_id == user.id, Item.intent == "reminder")).one()
    assert stored.title == "call mom"


def test_ambiguous_reminder_asks_clarification_without_saved_claim(client, monkeypatch):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "Remind me tomorrow morning", "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["intent"] == "assistant"
    assert "What should I remind you about" in payload["assistant"]["text"]
    assert "saved" not in payload["assistant"]["text"].lower()


def test_profile_and_routine_tools_read_saved_data_without_provider_calls():
    user = create_test_user()
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(user.id),
                answers_json='{"main_goal": "career"}',
                profile_summary="Career-focused user who prefers direct answers.",
            )
        )
        session.add(
            DailyRoutine(
                user_id=int(user.id),
                wake_time="06:30",
                sleep_time="22:30",
                work_start="09:00",
                work_end="17:30",
                daily_habits="walk, reading",
            )
        )
        session.commit()

        profile = run_text_turn(
            session,
            _request("What do you know about me?", int(user.id)),
            existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
        )
        routine = run_text_turn(
            session,
            _request("What is my routine today?", int(user.id)),
            existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
        )

    assert profile.provider == "backend_tool"
    assert "Career-focused" in profile.text
    assert routine.provider == "backend_tool"
    assert "06:30" in routine.text
    assert "walk" in routine.text
