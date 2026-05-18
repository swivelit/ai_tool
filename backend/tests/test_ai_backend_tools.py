from datetime import timedelta

import pytest
from sqlmodel import select

from app.time_utils import utc_now
from app.ai.orchestrator import run_text_turn
from app.ai.types import AIProviderResponse, AIRequest
from app.database import SessionLocal
from app.models import AgentRun, DailyRoutine, DocumentArtifact, Item, UserProfile
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
    assert payload["item"]["category"] == "Home"
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


def test_reminder_clarification_followup_creates_reminder_without_provider_call(client, monkeypatch):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    first = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "Remind me tomorrow morning", "reply_language": "en"},
    )
    assert first.status_code == 200
    assert "What should I remind you about" in first.json()["assistant"]["text"]

    second = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "Call Amma", "reply_language": "en"},
    )

    assert second.status_code == 200
    payload = second.json()
    assert payload["item"]["intent"] == "reminder"
    assert payload["item"]["category"] == "Reminder"
    assert payload["item"]["title"] == "Call Amma"
    assert payload["item"]["datetime"]
    assert "tomorrow morning" in payload["assistant"]["text"]

    with SessionLocal() as session:
        reminders = session.exec(select(Item).where(Item.user_id == user.id, Item.intent == "reminder")).all()
    assert len(reminders) == 1
    assert reminders[0].title == "Call Amma"


def test_unrelated_followup_after_pending_reminder_answers_normally(client, monkeypatch):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    client.post(
        "/api/chat",
        headers=headers,
        json={"message": "Remind me tomorrow morning", "reply_language": "en"},
    )

    class _StaticProvider:
        def complete(self, request, route):
            return AIProviderResponse(
                text="A compiler translates source code.",
                provider="openai",
                model=route.model,
                route=route.route,
                reason=route.reason,
                language=route.language,
                intent=route.intent,
            )

    monkeypatch.setattr("app.ai.orchestrator.OpenAIProvider", lambda: _StaticProvider())

    response = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "What is a compiler?", "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["intent"] != "reminder"
    assert payload["assistant"]["text"].startswith("A compiler")

    with SessionLocal() as session:
        reminders = session.exec(select(Item).where(Item.intent == "reminder")).all()
    assert reminders == []


def test_dhoom_movie_after_pending_reminder_does_not_create_reminder(client, monkeypatch):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    first = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "Remind me tomorrow morning", "reply_language": "en"},
    )
    assert first.status_code == 200

    class _StaticProvider:
        def complete(self, request, route):
            return AIProviderResponse(
                text="Dhoom is an Indian action film franchise about heists and police chases.",
                provider="openai",
                model=route.model,
                route=route.route,
                reason=route.reason,
                language=route.language,
                intent=route.intent,
            )

    monkeypatch.setattr("app.ai.orchestrator.OpenAIProvider", lambda: _StaticProvider())

    second = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "Tell me about dhoom movie", "reply_language": "en"},
    )

    assert second.status_code == 200
    payload = second.json()
    assert payload["item"]["intent"] != "reminder"
    assert payload["pipeline"]["route_taken"] != "backend_tool_reminder_continuation"
    assert payload["pipeline"]["predicted_label"] != "reminder"
    assert "Dhoom" in payload["assistant"]["text"]
    with SessionLocal() as session:
        reminders = session.exec(select(Item).where(Item.user_id == user.id, Item.intent == "reminder")).all()
    assert reminders == []


def test_dhoom_movie_after_stale_reminder_context_is_never_reminder():
    user = create_test_user()

    class _StaticProvider:
        def complete(self, request, route):
            return AIProviderResponse(
                text="Dhoom is an Indian action movie franchise.",
                provider="openai",
                model=route.model,
                route=route.route,
                reason=route.reason,
                language=route.language,
                intent=route.intent,
            )

    stale_context = [
        {"user": "Remind me tomorrow morning", "assistant": "What should I remind you about?"},
        {"user": "hello", "assistant": "Hi. How can I help?"},
    ]
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            AIRequest(
                user_id=int(user.id),
                message="Tell me about dhoom movie",
                reply_language="en",
                channel="text",
                request_id="stale-dhoom-test",
                metadata={},
                context_turns=stale_context,
            ),
            existing_context={"openai_provider": _StaticProvider(), "sarvam_provider": _ExplodingProvider()},
        )
        reminders = session.exec(select(Item).where(Item.user_id == user.id, Item.intent == "reminder")).all()

    assert response.intent == "general"
    assert response.route == "agent_provider_qa"
    assert reminders == []


def test_greeting_is_local_and_does_not_call_openai():
    user = create_test_user()
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("hello", int(user.id)),
            existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
        )

    assert response.provider == "backend_tool"
    assert response.intent == "greeting"
    assert response.route == "agent_local_greeting"
    with SessionLocal() as session:
        run = session.exec(select(AgentRun).where(AgentRun.user_id == user.id)).one()
    assert run.final_route == "agent_local_greeting"
    assert run.provider_calls == 0


def test_low_cost_gate_blocks_providers_for_simple_local_commands():
    user = create_test_user()
    cases = [
        ("thanks", "thanks"),
        ("what can you do", "capabilities"),
        ("remember buy milk", "note"),
        ("add task file quarterly taxes", "task"),
    ]
    with SessionLocal() as session:
        for message, expected_intent in cases:
            response = run_text_turn(
                session,
                _request(message, int(user.id)),
                existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
            )
            assert response.provider == "backend_tool"
            assert response.intent == expected_intent
            assert response.route.startswith(("agent_local_", "agent_tool_"))


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


def test_tamil_tanglish_local_commands_route_to_backend_tools_without_provider_calls():
    user = create_test_user()
    cases = [
        ("நாளைக்கு காலை அம்மாவை call panna remind பண்ணு", "reminder", "Home"),
        ("வீட்டு EB bill reminder save பண்ணு", "reminder", "Home"),
        ("marketing follow up notes business folder ல வை", "note", "Business"),
    ]
    with SessionLocal() as session:
        for message, expected_intent, expected_category in cases:
            response = run_text_turn(
                session,
                AIRequest(
                    user_id=int(user.id),
                    message=message,
                    reply_language="ta",
                    channel="voice",
                    request_id="tamil-tool-test",
                    metadata={},
                ),
                existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
            )
            metadata = response.raw["item_metadata"]
            assert response.provider == "backend_tool"
            assert response.intent == expected_intent
            assert metadata["category"] == expected_category


def test_voice_document_command_creates_generated_file_under_category_date(client, monkeypatch, tmp_path):
    import app.main as main_module

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "DOCS_BASE_DIR", tmp_path.resolve())
    monkeypatch.setattr(main_module, "PDF_BASE_DIR", tmp_path.resolve() / "pdf")
    monkeypatch.setattr(main_module, "DOCX_BASE_DIR", tmp_path.resolve() / "docx")
    monkeypatch.setattr(main_module, "EXCEL_BASE_DIR", tmp_path.resolve() / "xlsx")
    monkeypatch.setattr(main_module, "PPT_BASE_DIR", tmp_path.resolve() / "pptx")
    user = create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={
            "message": "இந்த meeting points PDF ஆக்கி Work folder ல save பண்ணு",
            "reply_language": "ta",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["intent"] == "document"
    assert payload["item"]["category"] == "Work"
    with SessionLocal() as session:
        artifact = session.exec(select(DocumentArtifact).where(DocumentArtifact.user_id == user.id)).one()
    assert artifact.format == "pdf"
    assert artifact.category == "Work"
    assert f"pdf/Work/{artifact.created_at.date().isoformat()}/" in artifact.relative_path
    assert (tmp_path / artifact.relative_path).is_file()
    search = client.get(
        "/api/files/search?q=meeting&category=Work",
        headers=auth_headers("test-uid", "test@example.com"),
    )
    assert search.status_code == 200
    files = search.json()["files"]
    assert files[0]["download_id"]
    download = client.get(files[0]["download_url"], headers=auth_headers("test-uid", "test@example.com"))
    assert download.status_code == 200


@pytest.mark.parametrize(
    ("message", "expected_format", "expected_category"),
    [
        ("இந்த points Excel sheet ஆக்கி Business folder ல வை", "xlsx", "Business"),
        ("இந்த ideas PPT ஆக்கி Work folder ல save பண்ணு", "pptx", "Work"),
        ("meeting minutes DOCX ஆக்கி Work folder ல save பண்ணு", "docx", "Work"),
    ],
)
def test_voice_document_commands_create_all_supported_artifact_formats(
    client,
    monkeypatch,
    tmp_path,
    message,
    expected_format,
    expected_category,
):
    import app.main as main_module

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "DOCS_BASE_DIR", tmp_path.resolve())
    monkeypatch.setattr(main_module, "PDF_BASE_DIR", tmp_path.resolve() / "pdf")
    monkeypatch.setattr(main_module, "DOCX_BASE_DIR", tmp_path.resolve() / "docx")
    monkeypatch.setattr(main_module, "EXCEL_BASE_DIR", tmp_path.resolve() / "xlsx")
    monkeypatch.setattr(main_module, "PPT_BASE_DIR", tmp_path.resolve() / "pptx")
    user = create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": message, "reply_language": "ta"},
    )

    assert response.status_code == 200
    with SessionLocal() as session:
        artifact = session.exec(select(DocumentArtifact).where(DocumentArtifact.user_id == user.id)).one()
    assert artifact.format == expected_format
    assert artifact.category == expected_category
    assert f"{expected_format}/{expected_category}/{artifact.created_at.date().isoformat()}/" in artifact.relative_path
    assert (tmp_path / artifact.relative_path).is_file()


def test_voice_file_retrieval_finds_yesterday_business_artifact():
    user = create_test_user()
    yesterday = utc_now() - timedelta(days=1)
    with SessionLocal() as session:
        item = Item(
            intent="document",
            category="Business",
            raw_text="marketing follow up notes business folder ல வை",
            title="business notes",
            details="Business notes",
            source="voice",
            user_id=user.id,
            created_at=yesterday,
            updated_at=yesterday,
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        session.add(
            DocumentArtifact(
                user_id=int(user.id),
                item_id=int(item.id),
                title="business notes",
                format="pdf",
                category="Business",
                relative_path=f"pdf/Business/{yesterday.date().isoformat()}/business_notes.pdf",
                source_text="business notes",
                created_at=yesterday,
            )
        )
        session.commit()

        response = run_text_turn(
            session,
            _request("Open the business notes I told you yesterday", int(user.id)),
            existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
        )

    assert response.provider == "backend_tool"
    assert response.intent == "file_retrieval"
    assert response.raw["item_metadata"]["status"] == "found"
    assert response.raw["item_metadata"]["files"][0]["title"] == "business notes"


def test_files_search_is_scoped_to_authenticated_user():
    user_a = create_test_user("uid-a", "a@example.com")
    user_b = create_test_user("uid-b", "b@example.com")
    with SessionLocal() as session:
        item = Item(
            intent="document",
            category="Business",
            raw_text="private business notes",
            title="business notes",
            details="Business notes",
            source="voice",
            user_id=user_b.id,
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        session.add(
            DocumentArtifact(
                user_id=int(user_b.id),
                item_id=int(item.id),
                title="business notes",
                format="pdf",
                category="Business",
                relative_path=f"pdf/Business/{utc_now().date().isoformat()}/business_notes.pdf",
                source_text="business notes",
            )
        )
        session.commit()

    response_a = client_get_files_for_user("uid-a", "a@example.com")
    response_b = client_get_files_for_user("uid-b", "b@example.com")
    assert user_a.id != user_b.id
    assert response_a["files"] == []
    assert response_b["files"][0]["title"] == "business notes"


def client_get_files_for_user(uid: str, email: str) -> dict:
    from app.main import app
    from fastapi.testclient import TestClient

    with TestClient(app) as test_client:
        response = test_client.get(
            "/api/files/search?q=business&category=Business",
            headers=auth_headers(uid, email),
        )
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize(
    ("message", "tool_kind"),
    [
        ("Create a poster image for my shop", "image"),
        ("Edit this video clip for Instagram", "video"),
        ("Clean up this audio recording", "audio"),
    ],
)
def test_unsupported_creative_tool_returns_not_configured_without_success(message, tool_kind):
    user = create_test_user()
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request(message, int(user.id)),
            existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
        )

    assert response.provider == "backend_tool"
    assert response.intent == "creative_tool"
    tool = response.raw["item_metadata"]["tool"]
    assert tool["status"] == "not_configured"
    assert tool["kind"] == tool_kind
    assert "cannot claim" in response.text.lower() or "not configured" in response.text.lower()
