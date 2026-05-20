from __future__ import annotations

from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from conftest import auth_headers, create_test_user


def test_users_resolve_stabilized_shape(client: TestClient) -> None:
    # A valid authentication token but user not registered in DB
    response = client.get("/users/resolve", headers=auth_headers("unregistered-uid", "unregistered@example.com"))
    assert response.status_code == 200
    payload = response.json()
    assert payload == {"found": False, "user": None}


def test_error_response_contains_standardized_shape(client: TestClient) -> None:
    create_test_user()
    # 400 Bad Request
    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "   ", "reply_language": "en"},
    )
    assert response.status_code == 400
    payload = response.json()
    assert "detail" in payload
    assert "error" in payload
    assert payload["error"]["code"] == "BAD_REQUEST"
    assert payload["error"]["message"] == "message or text is required"
    assert isinstance(payload["error"]["safe_details"], dict)

    # 422 Validation Error
    response_422 = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": 12345},  # Invalid type, should be string
    )
    assert response_422.status_code == 422
    payload_422 = response_422.json()
    assert "detail" in payload_422
    assert "error" in payload_422
    assert payload_422["error"]["code"] == "VALIDATION_ERROR"
    assert "errors" in payload_422["error"]["safe_details"]


def test_api_tts_enforces_user_ownership(client: TestClient) -> None:
    # Valid auth token but not registered in database -> should raise 404 via get_owned_user
    response = client.post(
        "/api/tts",
        headers=auth_headers("unregistered-uid", "unregistered@example.com"),
        json={"text": "hello"},
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_chat_and_tts_character_limits(client: TestClient) -> None:
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    # Chat > 5000 chars -> 413
    long_chat = "A" * 5001
    chat_response = client.post(
        "/api/chat",
        headers=headers,
        json={"message": long_chat, "reply_language": "en"},
    )
    assert chat_response.status_code == 413
    assert chat_response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert "too long" in chat_response.json()["detail"].lower()

    # TTS > 1000 chars -> 413
    long_tts = "B" * 1001
    tts_response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": long_tts},
    )
    assert tts_response.status_code == 413
    assert tts_response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert "too long" in tts_response.json()["detail"].lower()


def test_rate_limiting_enforcement(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    # Temporarily enable chat_limiter in test
    monkeypatch.setattr(main_module.chat_limiter, "enabled", True)
    monkeypatch.setattr(main_module.chat_limiter, "limit", 2)
    # Clear history for this test key
    main_module.chat_limiter.history.clear()

    # We stub the chat pipeline runs to prevent actual LLM/OpenAI calls
    monkeypatch.setattr(
        main_module,
        "_run_agentic_or_pipeline",
        lambda *args, **kwargs: {"remodeled_english": "Test reply"}
    )
    monkeypatch.setattr(
        main_module,
        "run_orchestrator",
        lambda *args, **kwargs: {"intent": "GENERAL", "priority": "low"}
    )

    # First request
    r1 = client.post("/api/chat", headers=headers, json={"message": "hello", "reply_language": "en"})
    assert r1.status_code == 200

    # Second request
    r2 = client.post("/api/chat", headers=headers, json={"message": "hello again", "reply_language": "en"})
    assert r2.status_code == 200

    # Third request -> 429
    r3 = client.post("/api/chat", headers=headers, json={"message": "hello once more", "reply_language": "en"})
    assert r3.status_code == 429
    assert r3.json()["error"]["code"] == "TOO_MANY_REQUESTS"


def test_dynamic_db_liveness_health_checks(client: TestClient) -> None:
    # 1. Healthy database check
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"

    response_debug = client.get("/api/debug/health")
    assert response_debug.status_code == 200
    assert response_debug.json()["status"] == "ok"
    assert response_debug.json()["services"]["database_liveness"]["ok"] is True

    # 2. Simulated DB Failure
    with patch("app.main._check_db_liveness", return_value=(False, "unreachable connection")):
        response_failed = client.get("/health")
        assert response_failed.status_code == 503
        assert response_failed.json()["status"] == "degraded"

        response_debug_failed = client.get("/api/debug/health")
        assert response_debug_failed.status_code == 503
        assert response_debug_failed.json()["status"] == "degraded"
        assert response_debug_failed.json()["services"]["database_liveness"]["ok"] is False
        assert "unreachable connection" in response_debug_failed.json()["services"]["database_liveness"]["detail"]
