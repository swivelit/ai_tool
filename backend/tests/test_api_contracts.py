from __future__ import annotations

import logging
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import select

import app.main as main_module
import app.observability as observability
from app.database import SessionLocal
from app.models import AIUsageEvent, Conversation, Item, QACache, RagEmbedding
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
    assert payload["meta"]["ai_router_enabled"] is True


def test_voice_contract_uses_sarvam_stt_and_ai_router(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "_transcribe_audio_file", lambda *args, **kwargs: "voice hello")

    def fake_run_text_turn(session, ai_request, *, existing_context=None):
        assert ai_request.channel == "voice"
        assert ai_request.message == "voice hello"
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
    assert payload["assistant"]["text"] == "Voice answer"
    assert payload["meta"]["provider"] == "sarvam"


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
    assert getattr(stt_record, "transcript_hash")
    assert getattr(stt_record, "transcript_length") == len("voice hello")
    with SessionLocal() as session:
        stt_usage = session.exec(select(AIUsageEvent).where(AIUsageEvent.route == "sarvam_stt")).one()
    assert stt_usage.audio_seconds > 0
    metadata = json.loads(stt_usage.metadata_json)
    assert metadata["file_size"] > 0
    assert metadata["duration_estimation_method"]


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
    assert calls[0]["json"]["speaker"] == "shubh"
    assert calls[0]["json"]["model"] == "bulbul:v2"
    assert "inputs" not in calls[0]["json"]
    assert calls[0]["timeout"] == (5, 30)


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
