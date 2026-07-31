from __future__ import annotations

import logging
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import select
from sqlalchemy.engine import Connection
from alembic.runtime.migration import MigrationContext

import app.main as main_module
import app.observability as observability
from app.database import SessionLocal
from app.models import AIUsageEvent, Conversation, Item, QACache, RagEmbedding, UserProfile
from app.ai.router import AIProviderRouter
from app.ai.types import AIProviderResponse
from app.ai.usage import record_ai_usage_event
from conftest import auth_headers, create_test_user


def _stub_chat_pipeline(
    monkeypatch,
    *,
    assistant_text: str = "Test assistant reply",
    intent: str = "assistant",
    title: str = "Assistant",
    datetime: str | None = None,
):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "false")
    monkeypatch.setenv("AI_LEGACY_PIPELINE_ENABLED", "true")
    monkeypatch.setattr(
        main_module,
        "run_orchestrator",
        lambda client, text: {
            "intent": "GENERAL",
            "priority": "low",
            "confidence": 1.0,
            "matched_keyword": "",
        },
    )
    monkeypatch.setattr(
        main_module,
        "_run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": assistant_text,
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
            "route_taken": "agentic",
            "predicted_label": intent,
            "direct_answer_source": "backend_pipeline",
            "direct_answer_confidence": "1.0000",
            "cache_hit": "false",
        },
    )
    monkeypatch.setattr(
        main_module,
        "_metadata_for_item",
        lambda session, user_id, text, fallback_details: {
            "intent": intent,
            "category": "Other",
            "datetime": datetime,
            "title": title,
            "details": fallback_details,
        },
    )


def test_chat_requires_message_or_text(client):
    create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "   ", "reply_language": "en"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "message or text is required"


def test_chat_contract_uses_ai_router_when_enabled(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.message == "What is a compiler?"
        assert ai_request.context_turns == []
        assert ai_request.metadata["context_turn_count"] == 0
        return AIProviderResponse(
            text="A compiler translates source code into another form.",
            provider="openai",
            model="gpt-5-nano",
            route="openai_general",
            reason="unit_test",
            language="en",
            intent="general",
            estimated_cost_amount=0.0001,
            estimated_cost_currency="USD",
            raw={
                "endpoint": "responses",
                "model_candidates": ["gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini"],
                "openai_attempted_models": ["gpt-5-nano"],
                "fallback_attempted": False,
                "embedding_calls": 0,
                "primary_model_candidate": "gpt-5-nano",
                "selected_model_reason": "cost_optimizer_choice",
                "skipped_models": [],
                "model_health_skip_reason": "",
            },
        )

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "What is a compiler?", "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert set(payload.keys()) == {"ok", "item", "assistant", "pipeline", "meta"}
    assert payload["assistant"]["text"].startswith("A compiler")
    assert payload["pipeline"]["provider"] == "openai"
    assert payload["meta"]["provider"] == "openai"
    assert payload["meta"]["model_used"] == "gpt-5-nano"
    assert payload["meta"]["endpoint"] == "responses"
    assert payload["meta"]["model_candidates"] == ["gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini"]
    assert payload["meta"]["openai_attempted_models"] == ["gpt-5-nano"]
    assert payload["meta"]["embedding_calls"] == 0
    assert payload["meta"]["context_turn_count"] == 0
    assert payload["meta"]["primary_model_candidate"] == "gpt-5-nano"
    assert payload["meta"]["selected_model_reason"] == "cost_optimizer_choice"
    assert payload["meta"]["ai_router_enabled"] is True


def test_chat_without_client_source_saves_text_source(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.channel == "text"
        return AIProviderResponse(
            text="Text reply",
            provider="openai",
            model="gpt-5-nano",
            route="openai_general",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "typed message", "reply_language": "en"},
    )

    assert response.status_code == 200
    item_id = response.json()["item"]["id"]
    assert response.json()["item"]["source"] == "text"
    with SessionLocal() as session:
        stored = session.get(Item, item_id)
    assert stored is not None
    assert stored.user_id == user.id
    assert stored.source == "text"


def test_chat_handsfree_client_source_saves_handsfree_source(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.channel == "handsfree"
        assert ai_request.metadata["client_source"] == "handsfree"
        return AIProviderResponse(
            text="Voice reply",
            provider="openai",
            model="gpt-5-nano",
            route="openai_general",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        "/api/chat",
        headers=headers,
        json={
            "message": "handsfree message",
            "reply_language": "en",
            "client_source": "handsfree",
        },
    )

    assert response.status_code == 200
    item_id = response.json()["item"]["id"]
    assert response.json()["item"]["source"] == "handsfree"
    assert response.json()["meta"]["client_source"] == "handsfree"
    with SessionLocal() as session:
        stored = session.get(Item, item_id)
    assert stored is not None
    assert stored.user_id == user.id
    assert stored.source == "handsfree"


def test_chat_ai_request_includes_saved_profile_context(client, monkeypatch):
    user = create_test_user(name="Hari")
    headers = auth_headers("test-uid", "test@example.com")
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(user.id),
                answers_json=json.dumps(
                    {
                        "communication_tone": "direct",
                        "answer_length": "short",
                        "tamil_style": "chennai_conversational",
                        "goal": "ship faster",
                    }
                ),
                profile_summary="Hari likes concise implementation-focused answers.",
                questions_version=1,
            )
        )
        session.commit()

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        profile_context = ai_request.metadata["profile_context"]
        profile_prompt_context = ai_request.metadata["profile_prompt_context"]
        assert profile_context["profile_summary"] == "Hari likes concise implementation-focused answers."
        assert profile_context["communication_tone"] == "direct"
        assert profile_context["onboarding_answers"]["goal"] == "ship faster"
        assert "Hari likes concise" in profile_prompt_context
        return AIProviderResponse(
            text="Focus on the next implementation step.",
            provider="openai",
            model="gpt-5-nano",
            route="openai_general",
            reason="unit_test",
            language="en",
            intent="general",
            raw={"reply_language": "en"},
        )

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "What should I do next?", "reply_language": "en"},
    )

    assert response.status_code == 200
    assert response.json()["assistant"]["text"] == "Focus on the next implementation step."


def test_chat_ai_request_includes_sanitized_life_context(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        profile_context = ai_request.metadata["profile_context"]
        life_context = profile_context["life_context"]
        dumped = json.dumps(life_context)
        assert life_context["movementSummary"] == "7,420 steps, about 5.7 km"
        assert life_context["screenSummary"] == "3.5 hours screen time"
        assert "productivity" in life_context["topAppsSummary"]
        assert "lifeInsightSummary" in life_context
        assert life_context["raw"]["movement"]["steps"] == 7420
        assert "ChatGPT" not in dumped
        assert "com.openai.chatgpt" not in dumped
        assert "private@example.com" not in dumped
        assert "sk-secret" not in dumped
        assert "life_context" in ai_request.metadata["profile_prompt_context"]
        return AIProviderResponse(
            text="You walked 7,420 steps and used your phone about 3.5 hours.",
            provider="openai",
            model="gpt-5-nano",
            route="openai_general",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        "/api/chat",
        headers=headers,
        json={
            "message": "How much did I walk today?",
            "reply_language": "en",
            "client_context": {
                "life_context": {
                    "enabled": True,
                    "date": "2026-05-28",
                    "shareAppNamesWithAi": False,
                    "movementSummary": "7,420 steps, about 5.7 km",
                    "screenSummary": "3.5 hours screen time",
                    "topAppsSummary": "ChatGPT 1 hour",
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
                        "generatedAt": "2026-05-28T00:00:00Z",
                    },
                    "email": "private@example.com",
                    "api_key": "sk-secret",
                }
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["assistant"]["text"].startswith("You walked")


def test_chat_ai_request_uses_client_life_context_age_when_profile_missing(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.metadata["age_group"] == "under_13"
        profile_context = ai_request.metadata["profile_context"]
        assert profile_context["age_group"] == "under_13"
        assert "minor" in profile_context["age_safety_note"]
        return AIProviderResponse(
            text="You walked 7,420 steps.",
            provider="openai",
            model="gpt-5-nano",
            route="openai_general",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        "/api/chat",
        headers=headers,
        json={
            "message": "How much did I walk today?",
            "reply_language": "en",
            "client_context": {
                "life_context": {
                    "enabled": True,
                    "ageGroup": "under_13",
                    "shareAppNamesWithAi": False,
                    "raw": {"apps": []},
                }
            },
        },
    )
    assert response.status_code == 200


def test_chat_ai_request_respects_prefer_not_to_say_over_client_age(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    with SessionLocal() as session:
        session.add(
            UserProfile(
                user_id=int(user.id),
                answers_json=json.dumps({"age_group": "prefer_not_to_say"}),
                profile_summary="Private age profile.",
                questions_version=1,
            )
        )
        session.commit()

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.metadata["age_group"] == ""
        assert "age_group" not in ai_request.metadata["profile_context"]
        assert "age_safety_note" not in ai_request.metadata["profile_context"]
        return AIProviderResponse(
            text="Life context is available.",
            provider="openai",
            model="gpt-5-nano",
            route="openai_general",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)
    response = client.post(
        "/api/chat",
        headers=headers,
        json={
            "message": "How much did I walk today?",
            "reply_language": "en",
            "client_context": {"life_context": {"enabled": True, "ageGroup": "under_13"}},
        },
    )
    assert response.status_code == 200


def test_backend_life_context_question_matches_tamil_and_tanglish():
    assert main_module._is_life_context_question("இன்று நான் எவ்வளவு நடந்தேன்?")
    assert main_module._is_life_context_question("phone evlo neram use panninen?")
    assert main_module._is_life_context_question("enna apps adhigama use panninen?")


def test_chat_contract_passes_recent_context_to_ai_router(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")

    def first_turn(session, ai_request, *, existing_context=None):
        return AIProviderResponse(
            text="A compiler translates source code into another form.",
            provider="openai",
            model="gpt-5-nano",
            route="openai_general",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setattr(main_module, "run_text_turn", first_turn)
    first = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "What is a compiler?", "reply_language": "en"},
    )
    assert first.status_code == 200

    def second_turn(session, ai_request, *, existing_context=None):
        assert ai_request.metadata["context_turn_count"] == 1
        assert ai_request.context_turns[-1]["user"] == "What is a compiler?"
        assert "compiler translates" in ai_request.context_turns[-1]["assistant"]
        return AIProviderResponse(
            text="கம்பைலர் code-ஐ மாற்றும்.",
            provider="sarvam",
            model="sarvam-30b",
            route="sarvam_contextual_explain",
            reason="unit_test",
            language="ta",
            intent="contextual_explain",
        )

    monkeypatch.setattr(main_module, "run_text_turn", second_turn)
    second = client.post(
        "/api/chat",
        headers=headers,
        json={"message": "Tamil la simple ah explain pannunga", "reply_language": "en"},
    )

    assert second.status_code == 200
    assert second.json()["meta"]["context_turn_count"] == 1


def test_voice_contract_uses_sarvam_stt_and_ai_router(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    stt_calls = []

    def fake_transcribe(*args, **kwargs):
        stt_calls.append((args, kwargs))
        return "voice hello"

    monkeypatch.setattr(main_module, "_transcribe_audio_file", fake_transcribe)

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.channel == "voice"
        assert ai_request.message == "voice hello"
        assert ai_request.reply_language == "en"
        return AIProviderResponse(
            text="Voice answer",
            provider="sarvam",
            model="sarvam-30b",
            route="sarvam_general",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en",
        headers=headers,
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["raw_text"] == "voice hello"
    assert payload["item"]["details"] == "Voice answer"
    assert payload["item"]["source"] == "voice"
    assert payload["assistant"]["text"] == "Voice answer"
    assert payload["meta"]["provider"] == "sarvam"
    assert stt_calls[0][0][1] is None
    with SessionLocal() as session:
        stored = session.get(Item, payload["item"]["id"])
    assert stored is not None
    assert stored.source == "voice"


def test_voice_contract_respects_tamil_reply_query_and_autodetects_speech(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    stt_calls = []

    def fake_transcribe(*args, **kwargs):
        stt_calls.append((args, kwargs))
        return "voice hello"

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.reply_language == "ta"
        return AIProviderResponse(
            text="Seri, unga voice answer ready.",
            provider="sarvam",
            model="sarvam-30b",
            route="sarvam_general",
            reason="unit_test",
            language="ta",
            intent="general",
        )

    monkeypatch.setattr(main_module, "_transcribe_audio_file", fake_transcribe)
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=ta&speech_language=auto",
        headers=headers,
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )

    assert response.status_code == 200
    assert stt_calls[0][0][1] is None
    payload = response.json()
    assert payload["item"]["details"] == "Seri, unga voice answer ready."
    assert payload["assistant"]["text"] == "Seri, unga voice answer ready."


def test_voice_spitzola_wake_word_question_is_not_greeting_response(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    transcript = "Hey Elli, can you tell me about Spitzola? I think it's a disease or something."

    monkeypatch.setattr(main_module, "_transcribe_audio_file", lambda *args, **kwargs: transcript)

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        route = AIProviderRouter().select_route(ai_request)
        assert route.intent != "greeting"
        assert route.route != "backend_tool_greeting"
        return AIProviderResponse(
            text="I’m not finding a well-known disease called ‘Spitzola’. It may be misspelled or misheard.",
            provider="openai",
            model="gpt-5-nano",
            route=route.route,
            reason="unit_test",
            language=route.language,
            intent=route.intent,
            raw={
                "reply_language": ai_request.reply_language,
                "intent_before_cleanup": route.metadata["intent_before_cleanup"],
                "intent_after_cleanup": route.metadata["intent_after_cleanup"],
                "normalized_message": route.metadata["normalized_message"],
                "stripped_wake_word": route.metadata["stripped_wake_word"],
            },
        )

    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en",
        headers=headers,
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["assistant"]["text"] != "Hi. How can I help?"
    assert payload["pipeline"]["predicted_label"] != "greeting"
    assert payload["pipeline"]["route_taken"] != "agent_local_greeting"
    assert payload["pipeline"]["route_taken"] != "backend_tool_greeting"
    assert payload["pipeline"]["predicted_label"] == "general"


def test_observability_config_endpoint(client):
    create_test_user()
    response = client.get(
        "/api/debug/observability",
        headers=auth_headers("test-uid", "test@example.com"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert "environment" in payload
    assert "release" in payload
    assert "log_chat_content" in payload
    assert "log_chat_content_max_chars" in payload
    assert "client_turn_logs_enabled" in payload
    assert "chat_turn_summary_logs_enabled" in payload
    assert "OPENAI_API_KEY" not in response.text
    assert "SARVAM_API_KEY" not in response.text
    assert "Bearer" not in response.text


def test_version_endpoint_exposes_release_and_safe_provider_config(client, monkeypatch):
    monkeypatch.setenv("APP_RELEASE_SHA", "release-sha-test")
    monkeypatch.setenv("APP_RELEASE_TIMESTAMP", "2026-05-18T00:00:00Z")
    monkeypatch.setenv("SARVAM_API_KEY", "sarvam-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")

    response = client.get("/api/version")

    assert response.status_code == 200
    payload = response.json()
    assert payload["backend_release_sha"] == "release-sha-test"
    assert payload["release_timestamp"] == "2026-05-18T00:00:00Z"
    assert payload["AI_ROUTER_ENABLED"] is True
    assert payload["AGENTIC_MODE_ENABLED"] is True
    assert payload["providers"] == {"sarvam_configured": True, "openai_configured": True}
    dumped = json.dumps(payload)
    assert "sarvam-secret" not in dumped
    assert "openai-secret" not in dumped
    assert "postgresql://" not in dumped
    assert "sqlite://" not in dumped
    assert set(payload["alembic"]) >= {"current", "head", "ok"}


def test_alembic_status_opens_engine_and_accepts_existing_connection(monkeypatch):
    configured_with = []

    class Context:
        @staticmethod
        def get_current_revision():
            return "d6f1a8c3e9b4"

    monkeypatch.setattr(
        MigrationContext, "configure",
        lambda bind: configured_with.append(bind) or Context(),
    )

    class TemporaryConnection:
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            self.closed = True
        closed = False

    connection = TemporaryConnection()

    class EngineLike:
        def connect(self):
            return connection

    engine_status = main_module._alembic_revision_status(
        SimpleNamespace(get_bind=lambda: EngineLike())
    )
    assert engine_status == {
        "current": "d6f1a8c3e9b4", "head": "d6f1a8c3e9b4", "ok": True,
    }
    assert configured_with[-1] is connection
    assert connection.closed is True

    from app.database import engine
    with engine.connect() as live_connection:
        assert isinstance(live_connection, Connection)
        direct_status = main_module._alembic_revision_status(
            SimpleNamespace(get_bind=lambda: live_connection)
        )
        assert configured_with[-1] is live_connection
        assert direct_status["head"] == "d6f1a8c3e9b4"


def test_alembic_status_failure_is_publicly_safe(monkeypatch):
    secret = "postgresql://username:password@private-host/database"

    class BrokenEngine:
        def connect(self):
            raise RuntimeError(secret)

    status = main_module._alembic_revision_status(
        SimpleNamespace(get_bind=lambda: BrokenEngine())
    )
    assert status == {
        "current": None, "head": "d6f1a8c3e9b4", "ok": False,
        "error": "alembic_connection_failed",
    }
    assert secret not in json.dumps(status)


def test_global_qa_cache_debug_endpoint_is_admin_only(client, monkeypatch):
    monkeypatch.setenv("ADMIN_EMAILS", "admin@example.com")
    monkeypatch.setenv("DEBUG_ADMIN_TOKEN", "debug-secret")
    create_test_user("normal-uid", "normal@example.com")
    create_test_user("admin-uid", "admin@example.com")

    normal = client.get(
        "/api/debug/global-qa-cache",
        headers=auth_headers("normal-uid", "normal@example.com"),
    )
    assert normal.status_code == 403

    admin = client.get(
        "/api/debug/global-qa-cache",
        headers=auth_headers("admin-uid", "admin@example.com"),
    )
    assert admin.status_code == 200

    token = client.get(
        "/api/debug/global-qa-cache",
        headers={"x-admin-token": "debug-secret"},
    )
    assert token.status_code == 200

    invalid = client.get(
        "/api/debug/global-qa-cache",
        headers={"x-admin-token": "wrong"},
    )
    assert invalid.status_code == 403


def test_global_qa_cache_debug_endpoint_denies_when_admin_unconfigured(client, monkeypatch):
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)
    monkeypatch.delenv("DEBUG_ADMIN_TOKEN", raising=False)
    create_test_user("admin-uid", "admin@example.com")

    response = client.get(
        "/api/debug/global-qa-cache",
        headers=auth_headers("admin-uid", "admin@example.com"),
    )

    assert response.status_code == 403


def test_chat_logs_turn_started_and_completed_safely(client, monkeypatch, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    _stub_chat_pipeline(monkeypatch, assistant_text="Safe backend answer")
    monkeypatch.setattr(observability, "LOG_CHAT_CONTENT", False)

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/chat",
            headers=headers,
            json={"message": "private cricket question", "reply_language": "en"},
        )

    assert response.status_code == 200
    started = [r for r in caplog.records if getattr(r, "event", "") == "chat_turn_started"]
    completed = [r for r in caplog.records if getattr(r, "event", "") == "chat_turn_completed"]
    assert started
    assert completed
    assert getattr(started[-1], "question_hash")
    assert getattr(started[-1], "question_length") == len("private cricket question")
    assert not hasattr(started[-1], "question_preview")
    assert getattr(completed[-1], "question_hash")
    assert getattr(completed[-1], "question_length") == len("private cricket question")
    assert not hasattr(completed[-1], "question_preview")
    assert getattr(completed[-1], "route_taken") == "agentic"
    assert getattr(completed[-1], "agent_source") in {"backend_pipeline", "backend_openai", "backend_cache"}
    assert getattr(completed[-1], "answer_hash")
    assert "private cricket question" not in caplog.text
    assert "Safe backend answer" not in caplog.text
    assert user.id is not None


def test_chat_accepts_client_fallback_metadata_and_preserves_request_id(client, monkeypatch, caplog):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    _stub_chat_pipeline(monkeypatch, assistant_text="Forced backend fallback answer")
    request_id = "text_contract_fallback_15s"

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/chat",
            headers=headers,
            json={
                "message": "What is the weather tomorrow?",
                "reply_language": "en",
                "request_id": request_id,
                "client_fallback_reason": "local_timeout",
                "client_local_budget_ms": 15000,
                "client_original_route": "local_answer",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["assistant"]["text"] == "Forced backend fallback answer"
    assert payload["meta"]["request_id"] == request_id
    assert payload["meta"]["route"]
    assert payload["meta"]["source"]
    assert "model_used" in payload["meta"]
    assert "model_tier" in payload["meta"]
    assert payload["meta"]["fallback_reason"] == "local_timeout"
    assert payload["meta"]["client_local_budget_ms"] == 15000
    assert payload["meta"]["original_route"] == "local_answer"

    received = [r for r in caplog.records if getattr(r, "event", "") == "backend_chat_received"][-1]
    started = [r for r in caplog.records if getattr(r, "event", "") == "backend_openai_fallback_started"][-1]
    assert getattr(received, "request_id") == request_id
    assert getattr(started, "request_id") == request_id
    assert getattr(received, "client_fallback_reason") == "local_timeout"
    assert getattr(started, "client_fallback_reason") == "local_timeout"
    assert getattr(started, "client_local_budget_ms") == 15000
    assert getattr(started, "client_original_route") == "local_answer"


def test_chat_turn_summary_without_content(client, monkeypatch, caplog):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    _stub_chat_pipeline(monkeypatch, assistant_text="Summary backend answer")
    monkeypatch.setattr(observability, "LOG_CHAT_CONTENT", False)
    monkeypatch.setattr(main_module, "CHAT_TURN_SUMMARY_LOGS_ENABLED", True)

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/chat",
            headers=headers,
            json={"message": "private IPL question", "reply_language": "en"},
        )

    assert response.status_code == 200
    summary = [r for r in caplog.records if getattr(r, "event", "") == "chat_turn_summary"][-1]
    assert getattr(summary, "question_hash")
    assert getattr(summary, "answer_hash")
    assert getattr(summary, "question_length") == len("private IPL question")
    assert getattr(summary, "answer_length") == len("Summary backend answer")
    assert not hasattr(summary, "question_preview")
    assert not hasattr(summary, "answer_preview")
    assert getattr(summary, "agent_source") in {"backend_pipeline", "backend_openai", "backend_cache"}
    assert getattr(summary, "route_taken") == "agentic"
    assert getattr(summary, "duration_ms") >= 0
    assert "private IPL question" not in caplog.text
    assert "Summary backend answer" not in caplog.text


def test_chat_logs_truncated_previews_when_enabled(client, monkeypatch, caplog):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    _stub_chat_pipeline(monkeypatch, assistant_text="answer preview text")
    monkeypatch.setattr(observability, "LOG_CHAT_CONTENT", True)
    monkeypatch.setattr(observability, "LOG_CHAT_CONTENT_MAX_CHARS", 8)

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/chat",
            headers=headers,
            json={"message": "question preview text", "reply_language": "en"},
        )

    assert response.status_code == 200
    started = [r for r in caplog.records if getattr(r, "event", "") == "chat_turn_started"][-1]
    completed = [r for r in caplog.records if getattr(r, "event", "") == "chat_turn_completed"][-1]
    assert getattr(started, "question_preview") == "question..."
    assert getattr(completed, "question_preview") == "question..."
    assert getattr(completed, "answer_preview") == "answer p..."


def test_chat_turn_summary_with_content(client, monkeypatch, caplog):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    _stub_chat_pipeline(monkeypatch, assistant_text="answer preview text")
    monkeypatch.setattr(observability, "LOG_CHAT_CONTENT", True)
    monkeypatch.setattr(observability, "LOG_CHAT_CONTENT_MAX_CHARS", 12)
    monkeypatch.setattr(main_module, "CHAT_TURN_SUMMARY_LOGS_ENABLED", True)

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/chat",
            headers=headers,
            json={"message": "question preview text", "reply_language": "en"},
        )

    assert response.status_code == 200
    summary = [r for r in caplog.records if getattr(r, "event", "") == "chat_turn_summary"][-1]
    assert getattr(summary, "question_preview") == "question pre..."
    assert getattr(summary, "answer_preview") == "answer previ..."
    assert getattr(summary, "route_taken") == "agentic"
    assert getattr(summary, "duration_ms") >= 0


def test_client_turn_log_accepts_local_telemetry_safely(client, monkeypatch, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(observability, "LOG_CHAT_CONTENT", True)

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/client/turn-log",
            headers=headers,
            json={
                "event": "client_local_turn_completed",
                "user_id": user.id,
                "channel": "text",
                "question": "hello bearer secret-token",
                "answer": "local answer",
                "agent_source": "local_rules",
                "route_taken": "fast_greeting",
                "workflow_step": "quick_reply_check",
                "workflow_phase": "completed",
                "step_index": 2,
                "decision": "hit",
                "cache_hit": False,
                "cache_source": "local_rules",
                "global_sync_status": "ok",
                "http_status": 200,
                "error_name": "None",
                "error_message": "",
                "model_used": "local_rules",
                "model_tier": "rules",
                "native_backend": "llama_cpp",
                "local_runtime_mode": "native_on_device",
                "db_schema_ready": True,
                "screen": "chat",
                "app_state": "active",
                "mobile_build_id": "build-test-1",
                "mobile_git_sha": "abc1234",
                "local_to_backend_fallback_ms": 15000,
                "cloud_fallback_enabled": True,
                "native_safety_status": {
                    "generalChat": {
                        "safe": False,
                        "reason": "native_smoke_test_not_verified",
                    }
                },
            },
        )

    assert response.status_code == 200
    record = [r for r in caplog.records if getattr(r, "event", "") == "client_local_turn_completed"][-1]
    assert getattr(record, "question_hash")
    assert getattr(record, "answer_hash")
    assert getattr(record, "question_preview") == "hello bearer [REDACTED]"
    assert getattr(record, "agent_source") == "local_rules"
    assert getattr(record, "workflow_step") == "quick_reply_check"
    assert getattr(record, "workflow_phase") == "completed"
    assert getattr(record, "step_index") == 2
    assert getattr(record, "decision") == "hit"
    assert getattr(record, "cache_hit") is False
    assert getattr(record, "http_status") == 200
    assert getattr(record, "model_used") == "local_rules"
    assert getattr(record, "db_schema_ready") is True
    assert getattr(record, "mobile_build_id") == "build-test-1"
    assert getattr(record, "mobile_git_sha") == "abc1234"
    assert getattr(record, "local_to_backend_fallback_ms") == 15000
    assert getattr(record, "cloud_fallback_enabled") is True
    assert getattr(record, "native_safety_status")["generalChat"]["safe"] is False
    assert "secret-token" not in caplog.text


def test_client_turn_log_hashes_without_content_preview(client, monkeypatch, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(observability, "LOG_CHAT_CONTENT", False)

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/client/turn-log",
            headers=headers,
            json={
                "event": "client_local_path_skipped_for_safety",
                "user_id": user.id,
                "channel": "text",
                "question": "private general question",
                "agent_source": "local_safety_guard",
                "route_taken": "local_native_guard",
                "workflow_step": "native_inference_guard",
                "workflow_phase": "skipped",
                "fallback_reason": "local_model_unavailable",
                "error_type": "active_workflow_marker_found",
            },
        )

    assert response.status_code == 200
    record = [r for r in caplog.records if getattr(r, "event", "") == "client_local_path_skipped_for_safety"][-1]
    assert getattr(record, "question_hash")
    assert getattr(record, "question_length") == len("private general question")
    assert not hasattr(record, "question_preview")
    assert getattr(record, "workflow_step") == "native_inference_guard"
    assert getattr(record, "fallback_reason") == "local_model_unavailable"
    assert "private general question" not in caplog.text


def test_client_turn_log_emits_client_turn_summary(client, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/client/turn-log",
            headers=headers,
            json={
                "event": "client_local_turn_completed",
                "user_id": user.id,
                "request_id": "turn-123",
                "turn_id": "turn-123",
                "channel": "text",
                "question": "hello",
                "answer": "hi",
                "agent_source": "local_rules",
                "route_taken": "fast_greeting",
                "duration_ms": 12.5,
            },
        )

    assert response.status_code == 200
    summary = [r for r in caplog.records if getattr(r, "event", "") == "client_turn_summary"][-1]
    assert getattr(summary, "client_event") == "client_local_turn_completed"
    assert getattr(summary, "agent_source") == "local_rules"
    assert getattr(summary, "route_taken") == "fast_greeting"
    assert getattr(summary, "telemetry_delivery") == "received"
    assert getattr(summary, "duration_ms") == 12.5
    assert getattr(summary, "question_hash")
    assert getattr(summary, "answer_hash")


def test_local_timeout_general_chat_uses_backend_fast_fallback(client, monkeypatch, caplog):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "false")
    monkeypatch.setenv("AI_LEGACY_PIPELINE_ENABLED", "true")
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    calls = []

    def fake_tracked_chat_completion(client_arg, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(
                        content="Solo Leveling is a Korean action-fantasy story about Sung Jinwoo growing from the weakest hunter into an exceptionally powerful one."
                    )
                )
            ]
        )

    def fail_long_pipeline(*args, **kwargs):
        raise AssertionError("long backend pipeline should not run for fast fallback")

    monkeypatch.setattr(main_module, "_get_openai_client", lambda required=True: object())
    monkeypatch.setattr(main_module, "tracked_chat_completion", fake_tracked_chat_completion)
    monkeypatch.setattr(main_module, "run_orchestrator", fail_long_pipeline)
    monkeypatch.setattr(main_module, "_run_agentic_or_pipeline", fail_long_pipeline)
    monkeypatch.setattr(main_module, "_metadata_for_item", fail_long_pipeline)

    with caplog.at_level(logging.INFO):
        response = client.post(
            "/api/chat",
            headers=headers,
            json={
                "message": "Tell me about solo leveling",
                "reply_language": "en",
                "request_id": "text_fast_fallback_1",
                "client_fallback_reason": "local_timeout",
                "client_local_budget_ms": 15000,
                "client_original_route": "local_answer",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert len(calls) == 1
    assert calls[0]["route"] == "backend_fast_fallback"
    assert calls[0]["task"] == "normal_qa"
    assert payload["assistant"]["text"].startswith("Solo Leveling is")
    assert payload["pipeline"]["route_taken"] == "backend_fast_fallback"
    assert payload["pipeline"]["predicted_label"] == "general_qa"
    assert payload["pipeline"]["direct_answer_source"] == "backend_openai_fast_fallback"
    assert payload["meta"]["source"] == "backend_openai"
    assert payload["meta"]["fallback_reason"] == "local_timeout"
    assert payload["meta"]["client_local_budget_ms"] == 15000
    completed = [r for r in caplog.records if getattr(r, "event", "") == "chat_turn_completed"][-1]
    assert getattr(completed, "route_taken") == "backend_fast_fallback"
    assert getattr(completed, "predicted_label") == "general_qa"
    assert getattr(completed, "direct_answer_source") == "backend_openai_fast_fallback"
    assert getattr(completed, "fallback_reason") == "local_timeout"


def test_observability_startup_log(monkeypatch, caplog):
    monkeypatch.setattr(main_module, "LOG_CHAT_CONTENT", True)
    with caplog.at_level(logging.INFO):
        main_module.emit_observability_config_log()

    record = [r for r in caplog.records if getattr(r, "event", "") == "observability_config"][-1]
    assert getattr(record, "log_chat_content") is True
    assert isinstance(getattr(record, "log_chat_content_max_chars"), int)
    assert getattr(record, "client_turn_logs_enabled") in {True, False}
    assert getattr(record, "chat_turn_summary_logs_enabled") in {True, False}
    assert "OPENAI_API_KEY" not in caplog.text
    assert "SARVAM_API_KEY" not in caplog.text
    assert "Bearer" not in caplog.text


def test_request_failed_exception_is_logged(monkeypatch, caplog):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    def explode(session, payload):
        raise RuntimeError("synthetic backend failure bearer secret-token")

    monkeypatch.setattr(main_module, "_run_chat_request", explode)

    with caplog.at_level(logging.ERROR):
        with TestClient(main_module.app, raise_server_exceptions=False) as test_client:
            response = test_client.post(
                "/api/chat",
                headers=headers,
                json={"message": "hello", "reply_language": "en"},
            )

    assert response.status_code == 500
    records = [record for record in caplog.records if getattr(record, "event", "") == "request_failed_exception"]
    assert records
    record = records[-1]
    assert getattr(record, "exception_class") in {"RuntimeError", "ExceptionGroup"}
    assert "bearer [REDACTED]" in getattr(record, "exception_message")
    assert getattr(record, "duration_ms") >= 0


def test_chat_openai_configuration_error_returns_sanitized_503(monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    def explode(session, payload):
        raise main_module.OpenAIConfigurationError(
            "invalid OpenAI config OPENAI_API_KEY=sk-secret-token bearer firebase-token provider response"
        )

    monkeypatch.setattr(main_module, "_run_chat_request", explode)

    with TestClient(main_module.app, raise_server_exceptions=False) as test_client:
        response = test_client.post(
            "/api/chat",
            headers=headers,
            json={"message": "Explain quantum computing in simple words", "reply_language": "en"},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == main_module.OPENAI_PROVIDER_CONFIG_DETAIL
    assert "sk-secret-token" not in response.text
    assert "firebase-token" not in response.text
    assert "provider response" not in response.text


def test_voice_upload_rejects_missing_auth_missing_file_bad_type_and_large_file(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    no_auth = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}",
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )
    assert no_auth.status_code == 401

    missing_file = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}",
        headers=headers,
    )
    assert missing_file.status_code == 422

    bad_type = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}",
        headers=headers,
        files={"file": ("audio.txt", b"audio", "text/plain")},
    )
    assert bad_type.status_code == 415

    monkeypatch.setattr(main_module, "MAX_UPLOAD_BYTES", 8)
    too_large = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}",
        headers=headers,
        files={"file": ("audio.m4a", b"123456789", "audio/m4a")},
    )
    assert too_large.status_code == 413

    empty = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}",
        headers=headers,
        files={"file": ("audio.m4a", b"", "audio/m4a")},
    )
    assert empty.status_code == 400
    assert "Audio file is empty" in empty.json()["detail"]


def test_voice_rejects_cross_user_query_before_transcription(client, monkeypatch):
    user_a = create_test_user("uid-a", "a@example.com")
    user_b = create_test_user("uid-b", "b@example.com")
    transcribe = Mock(return_value="should not run")
    monkeypatch.setattr(main_module, "_transcribe_audio_file", transcribe)

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user_b.id}",
        headers=auth_headers("uid-a", "a@example.com"),
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )

    assert response.status_code == 403
    transcribe.assert_not_called()
    assert user_a.id != user_b.id


def test_voice_stt_failure_returns_client_error(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(
        main_module,
        "_transcribe_audio_file",
        lambda *args, **kwargs: (_ for _ in ()).throw(HTTPException(400, "bad audio")),
    )

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}",
        headers=headers,
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "bad audio"


def test_sarvam_stt_success_is_used_by_transcribe_and_analyze(client, monkeypatch, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")
    _stub_chat_pipeline(monkeypatch, assistant_text="Voice answer")

    class DummyResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"transcript": "voice hello"}

    calls = []

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        return DummyResponse()

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    with caplog.at_level(logging.INFO):
        response = client.post(
            f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en&speech_language=ta",
            headers=headers,
            files={"file": ("audio.m4a", b"audio", "audio/m4a")},
        )

    assert response.status_code == 200
    assert response.json()["item"]["raw_text"] == "voice hello"
    assert calls[0][0][0] == "https://api.sarvam.ai/speech-to-text"
    assert calls[0][1]["headers"]["api-subscription-key"] == "test-key"
    assert "Content-Type" not in calls[0][1]["headers"]
    assert "file" in calls[0][1]["files"]
    assert calls[0][1]["data"]["model"] == "saaras:v3"
    assert calls[0][1]["data"]["mode"] == "transcribe"
    assert calls[0][1]["data"]["language_code"] == "ta-IN"
    upload_record = [r for r in caplog.records if getattr(r, "event", "") == "voice_upload_received"][-1]
    assert getattr(upload_record, "upload_filename") == "audio.m4a"
    assert getattr(upload_record, "content_type") == "audio/m4a"
    assert getattr(upload_record, "size_bytes") > 0
    stt_record = [r for r in caplog.records if getattr(r, "event", "") == "sarvam_stt_completed"][-1]
    assert getattr(stt_record, "status_code") == 200
    assert getattr(stt_record, "transcript_characters") == len("voice hello")
    assert not hasattr(stt_record, "transcript_hash")
    assert not hasattr(stt_record, "transcript_preview")
    with SessionLocal() as session:
        stt_usage = session.exec(select(AIUsageEvent).where(AIUsageEvent.route == "sarvam_stt")).one()
    assert stt_usage.audio_seconds > 0
    metadata = json.loads(stt_usage.metadata_json)
    assert metadata["file_size"] > 0
    assert metadata["duration_estimation_method"]


def test_voice_route_preserves_mobile_mime_uses_profile_language_and_autodetects_speech(client, monkeypatch, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    calls: list[dict[str, str | None]] = []

    class FakeSarvamProvider:
        def stt_file(self, file_path, language=None, *, content_type=None, filename=None):
            calls.append(
                {
                    "file_path": file_path,
                    "language": language,
                    "content_type": content_type,
                    "filename": filename,
                }
            )
            return "voice hello"

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.channel == "voice"
        assert ai_request.reply_language == "en"
        assert ai_request.metadata["content_type"] == "audio/m4a"
        assert ai_request.metadata["provider_content_type"] == "application/octet-stream"
        return AIProviderResponse(
            text="Voice answer",
            provider="backend_tool",
            model=None,
            route="agent_local_voice_test",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setattr(main_module, "_get_sarvam_provider", lambda: FakeSarvamProvider())
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    with caplog.at_level(logging.INFO):
        response = client.post(
            f"/api/transcribe-and-analyze?user_id={user.id}",
            headers=headers,
            files={"file": ("audio.m4a", b"audio", "audio/m4a")},
        )

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0]["language"] is None
    assert calls[0]["content_type"] == "audio/m4a"
    assert calls[0]["filename"] == "audio.m4a"
    assert response.json()["assistant"]["text"] == "Voice answer"
    upload_record = [r for r in caplog.records if getattr(r, "event", "") == "voice_upload_received"][-1]
    assert getattr(upload_record, "reply_language") == "en"
    assert getattr(upload_record, "speech_language", None) is None
    with SessionLocal() as session:
        stt_usage = session.exec(select(AIUsageEvent).where(AIUsageEvent.route == "sarvam_stt")).one()
    metadata = json.loads(stt_usage.metadata_json)
    assert metadata["content_type"] == "audio/m4a"
    assert metadata["provider_content_type"] == "application/octet-stream"
    assert metadata["filename"] == "audio.m4a"


def test_transcribe_and_analyze_preserves_handsfree_client_source(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    captured_requests = []

    class FakeSarvamProvider:
        def stt_file(self, file_path, language=None, *, content_type=None, filename=None):
            return "handsfree hello"

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        captured_requests.append(ai_request)
        return AIProviderResponse(
            text="Handsfree answer",
            provider="backend_tool",
            model=None,
            route="agent_local_handsfree_test",
            reason="unit_test",
            language="en",
            intent="general",
        )

    monkeypatch.setattr(main_module, "_get_sarvam_provider", lambda: FakeSarvamProvider())
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}&client_source=handsfree",
        headers=headers,
        files={"file": ("handsfree-command.wav", b"audio", "audio/wav")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert captured_requests
    assert captured_requests[0].channel == "handsfree"
    assert captured_requests[0].metadata["client_source"] == "handsfree"
    assert payload["item"]["source"] == "handsfree"
    assert payload["meta"]["client_source"] == "handsfree"
    with SessionLocal() as session:
        item = session.exec(select(Item).where(Item.raw_text == "handsfree hello")).one()
        conversation = session.exec(
            select(Conversation).where(Conversation.user_input == "handsfree hello")
        ).one()
        stt_usage = session.exec(select(AIUsageEvent).where(AIUsageEvent.route == "sarvam_stt")).one()
    assert item.source == "handsfree"
    assert conversation.channel == "handsfree"
    assert json.loads(stt_usage.metadata_json)["client_source"] == "handsfree"


def test_voice_quota_blocks_before_stt_provider_call(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setenv("FREE_DAILY_VOICE_SECONDS", "1")
    transcribe = Mock(return_value="should not run")
    monkeypatch.setattr(main_module, "_transcribe_audio_file", transcribe)
    with SessionLocal() as session:
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text="voice",
                provider="sarvam",
                model="saaras:v3",
                route="sarvam_stt",
                reason="test",
                language="en-IN",
                intent="stt",
                audio_seconds=1.0,
            ),
            user_id=int(user.id),
        )

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en",
        headers=headers,
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )

    assert response.status_code == 429
    assert "Daily free voice limit" in response.json()["detail"]
    transcribe.assert_not_called()


def test_sarvam_stt_missing_key_returns_503(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "")
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en",
        headers=headers,
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "SARVAM_API_KEY is not configured."


def test_sarvam_stt_timeout_returns_504(client, monkeypatch, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    def fake_post(*args, **kwargs):
        raise main_module.requests.Timeout("slow provider")

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    with caplog.at_level(logging.INFO):
        response = client.post(
            f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en",
            headers=headers,
            files={"file": ("audio.m4a", b"audio", "audio/m4a")},
        )

    assert response.status_code == 504
    assert response.json()["detail"] == "STT provider timed out."
    failed = [r for r in caplog.records if getattr(r, "event", "") == "sarvam_stt_failed"][-1]
    assert getattr(failed, "status_code") == 504
    assert getattr(failed, "safe_provider_error") == "timeout"


def test_sarvam_stt_provider_error_redacts_backend_key(client, monkeypatch, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 401
        text = "api-subscription-key=test-key"

        def json(self):
            return {"error": {"message": "invalid test-key api-subscription-key=test-key"}}

    monkeypatch.setattr(main_module.requests, "post", lambda *args, **kwargs: DummyResponse())

    with caplog.at_level(logging.INFO):
        response = client.post(
            f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en",
            headers=headers,
            files={"file": ("audio.m4a", b"audio", "audio/m4a")},
        )

    assert response.status_code == 401
    detail = response.json()["detail"]
    assert "STT provider returned 401" in detail
    assert "test-key" not in detail
    assert "[REDACTED]" in detail
    assert "test-key" not in caplog.text


def test_tts_uses_modern_text_payload_and_returns_audio(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")
    monkeypatch.delenv("SARVAM_TTS_SPEAKER", raising=False)

    class DummyResponse:
        def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
            self.status_code = status_code
            self._payload = payload or {}
            self.text = text

        def json(self):
            return self._payload

    calls = []

    def fake_post(*args, **kwargs):
        calls.append({**kwargs, "json": dict(kwargs.get("json") or {})})
        return DummyResponse(200, {"audios": ["base64-audio"]})

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello", "target_language_code": "en-IN"},
    )

    assert response.status_code == 200
    assert response.json()["audio_base64"] == "base64-audio"
    assert calls[0]["json"]["text"] == "hello"
    assert calls[0]["json"]["target_language_code"] == "en-IN"
    assert calls[0]["json"]["speaker"] == "anushka"
    assert calls[0]["json"]["model"] == "bulbul:v2"
    assert "inputs" not in calls[0]["json"]
    assert calls[0]["timeout"] == (5, 30)


def test_tts_env_shubh_falls_back_to_anushka(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")
    monkeypatch.setenv("SARVAM_TTS_SPEAKER", "shubh")

    class DummyResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"audios": ["base64-audio"]}

    calls = []

    def fake_post(*args, **kwargs):
        calls.append({**kwargs, "json": dict(kwargs.get("json") or {})})
        return DummyResponse()

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello", "target_language_code": "en-IN"},
    )

    assert response.status_code == 200
    assert response.json()["audio_base64"] == "base64-audio"
    assert calls[0]["json"]["speaker"] == "anushka"


def test_tts_provider_missing_audio_returns_readable_failure(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"audios": []}

    monkeypatch.setattr(main_module.requests, "post", lambda *args, **kwargs: DummyResponse())

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello", "target_language_code": "en-IN"},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "TTS provider response did not contain audio."


def test_rag_embedding_failure_is_logged_and_does_not_rollback_saved_item(client, monkeypatch, caplog):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    _stub_chat_pipeline(monkeypatch, assistant_text="Saved despite RAG failure")
    monkeypatch.setattr(
        main_module.LOCAL_RAG_SERVICE,
        "_get_or_create_embedding",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("embedding down")),
    )
    caplog.set_level(logging.WARNING)

    response = client.post(
        "/api/chat",
        headers=headers,
        json={"user_id": user.id, "message": "remember this", "reply_language": "en"},
    )

    assert response.status_code == 200
    item_id = response.json()["item"]["id"]
    with SessionLocal() as session:
        saved = session.get(Item, item_id)
        assert saved is not None
        assert saved.details == "Saved despite RAG failure"
    assert "RAG embedding failed" in caplog.text


def test_reminder_item_can_be_created_listed_and_deleted(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    _stub_chat_pipeline(
        monkeypatch,
        assistant_text="I will remind you about Standup.",
        intent="reminder",
        title="Standup",
        datetime="2026-05-01T09:00:00",
    )

    created = client.post(
        "/api/chat",
        headers=headers,
        json={"user_id": user.id, "message": "remind me about standup", "reply_language": "en"},
    )
    assert created.status_code == 200
    item_id = created.json()["item"]["id"]

    listed = client.get(f"/items?user_id={user.id}", headers=headers)
    assert listed.status_code == 200
    reminders = [row for row in listed.json() if row["intent"] == "reminder"]
    assert len(reminders) == 1
    assert reminders[0]["id"] == item_id
    assert reminders[0]["datetime"] == "2026-05-01T09:00:00"

    deleted = client.delete(f"/items/{item_id}?user_id={user.id}", headers=headers)
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True, "id": item_id}

    fetched = client.get(f"/items/{item_id}?user_id={user.id}", headers=headers)
    assert fetched.status_code == 404


def test_delete_item_removes_related_memory_rows(client):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    with SessionLocal() as session:
        item = Item(
            user_id=user.id,
            intent="assistant",
            category="Other",
            raw_text="remember my trip",
            transcript="remember my trip",
            title="Trip",
            details="I will remember your trip.",
            source="voice",
        )
        qa_cache = QACache(
            user_id=user.id,
            question="remember my trip",
            answer='{"remodeled_english":"I will remember your trip."}',
        )
        conversation = Conversation(
            user_id=user.id,
            channel="voice",
            user_input="remember my trip",
            transcript="remember my trip",
            llm_output_json='{"remodeled_english":"I will remember your trip."}',
        )
        session.add(item)
        session.add(qa_cache)
        session.add(conversation)
        session.commit()
        session.refresh(item)
        session.refresh(qa_cache)
        session.refresh(conversation)

        rows = [
            RagEmbedding(
                user_id=user.id,
                source_type="item",
                source_id=str(item.id),
                content_hash="item-hash",
                content_text="item memory",
                embedding_json="[0.1]",
            ),
            RagEmbedding(
                user_id=user.id,
                source_type="qa_cache",
                source_id=str(qa_cache.id),
                content_hash="qa-hash",
                content_text="qa memory",
                embedding_json="[0.2]",
            ),
            RagEmbedding(
                user_id=user.id,
                source_type="conversation",
                source_id=str(conversation.id),
                content_hash="conversation-hash",
                content_text="conversation memory",
                embedding_json="[0.3]",
            ),
        ]
        for row in rows:
            session.add(row)
        session.commit()
        item_id = item.id
        qa_id = qa_cache.id
        conversation_id = conversation.id

    deleted = client.delete(f"/items/{item_id}?user_id={user.id}", headers=headers)
    assert deleted.status_code == 200

    with SessionLocal() as session:
        assert session.get(Item, item_id) is None
        assert session.get(QACache, qa_id) is None
        assert session.get(Conversation, conversation_id) is None
        remaining_embeddings = session.exec(
            main_module.select(RagEmbedding).where(RagEmbedding.user_id == user.id)
        ).all()
        assert remaining_embeddings == []
