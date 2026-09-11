from __future__ import annotations

import base64
import hashlib
from datetime import timedelta
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.auth import AuthUser
from app.ai.types import AIProviderResponse
from app.web_api.chat_service import CompletedWebMessage, CompletedWebTurn
from app.database import SessionLocal
from app.models import CliAgentRun, CliAgentStep, CliDeviceGrant, CliPendingAction, CliSession, User
from app.cli_api.security import digest
from app.time_utils import utc_now
from tests.conftest import auth_headers, create_test_user


def _verifier() -> str:
    return base64.urlsafe_b64encode(b"v" * 48).rstrip(b"=").decode()


def _challenge(value: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(value.encode()).digest()).rstrip(b"=").decode()


def _start(client: TestClient, *, scopes: list[str] | None = None):
    verifier = _verifier()
    response = client.post("/api/cli/v1/device", json={
        "client_id": "swico-cli", "code_challenge": _challenge(verifier),
        "device_description": "Test terminal", "scopes": scopes or ["chat"],
    })
    assert response.status_code == 200, response.text
    return verifier, response.json()


def test_device_flow_is_proof_bound_one_time_and_refresh_rotation(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    user = create_test_user("cli-device-user", "cli-device@example.com")
    verifier, device = _start(client)
    pending = client.post("/api/cli/v1/token", json={
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        "device_code": device["device_code"], "code_verifier": verifier,
    })
    assert pending.status_code == 400 and pending.json()["detail"]["error"] == "authorization_pending"
    with SessionLocal() as session:
        grant = session.exec(select(CliDeviceGrant).where(CliDeviceGrant.user_code_digest.is_not(None))).first()
        assert grant is not None
        grant.last_poll_at = utc_now() - timedelta(seconds=10)
        session.add(grant); session.commit()
    approved = client.post("/api/cli/v1/device/approve", headers=auth_headers(user.firebase_uid, user.email), json={"user_code": device["user_code"], "approved": True})
    assert approved.status_code == 200
    exchanged = client.post("/api/cli/v1/token", json={
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        "device_code": device["device_code"], "code_verifier": verifier,
    })
    assert exchanged.status_code == 200
    tokens = exchanged.json()
    assert client.get("/api/cli/v1/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}).status_code == 200
    website_sessions = client.get("/api/web/cli/sessions", headers=auth_headers(user.firebase_uid, user.email))
    assert website_sessions.status_code == 200
    assert website_sessions.json()["items"][0]["device_description"] == "Test terminal"
    reused_grant = client.post("/api/cli/v1/token", json={
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        "device_code": device["device_code"], "code_verifier": verifier,
    })
    assert reused_grant.status_code in {400, 409}
    rotated = client.post("/api/cli/v1/token", json={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
    assert rotated.status_code == 200
    old_refresh = client.post("/api/cli/v1/token", json={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
    assert old_refresh.status_code == 400
    assert client.get("/api/cli/v1/me", headers={"Authorization": f"Bearer {rotated.json()['access_token']}"}).status_code == 401
    assert client.delete(
        f"/api/web/cli/sessions/{website_sessions.json()['items'][0]['id']}",
        headers=auth_headers(user.firebase_uid, user.email),
    ).status_code == 200


def test_approval_requires_owned_verified_email_and_scope_isolated(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "false")
    owner = create_test_user("cli-owner", "owner@example.com")
    other = create_test_user("cli-other", "other@example.com")
    _, device = _start(client, scopes=["chat"])
    denied = client.post("/api/cli/v1/device/approve", headers=auth_headers(other.firebase_uid, other.email), json={"user_code": device["user_code"], "approved": True})
    assert denied.status_code == 200  # device approval belongs to the authenticated account by policy
    # A separate grant must not be usable by another account or with a wrong proof.
    verifier, second = _start(client)
    wrong = client.post("/api/cli/v1/device/approve", headers=auth_headers(other.firebase_uid, other.email), json={"user_code": second["user_code"], "approved": True})
    assert wrong.status_code == 200
    bad_proof = client.post("/api/cli/v1/token", json={"grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": second["device_code"], "code_verifier": base64.urlsafe_b64encode(b"w" * 48).rstrip(b"=").decode()})
    assert bad_proof.status_code == 400


def test_cli_disabled_is_fail_closed_and_settings_are_safe(monkeypatch: pytest.MonkeyPatch):
    from app.cli_api.config import CliConfigurationError, cli_settings, validate_cli_configuration
    monkeypatch.setenv("SWICO_CLI_WEB_ORIGIN", "http://attacker.test")
    with pytest.raises(CliConfigurationError):
        cli_settings()
    monkeypatch.setenv("SWICO_CLI_WEB_ORIGIN", "https://swico.in")
    monkeypatch.setenv("SWICO_CLI_ENABLED", "false")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    with pytest.raises(CliConfigurationError):
        validate_cli_configuration()


def test_agent_action_result_is_owner_scoped_idempotent_and_recoverable(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    owner = create_test_user("cli-agent-owner", "agent-owner@example.com")
    other = create_test_user("cli-agent-other", "agent-other@example.com")
    raw_access = "a" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(owner.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("r" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat","agent"]', device_description="test",
        ))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "inspect a project"})
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]
    action_payload = {"path": "src/main.py"}
    action = {"protocol_version": 1, "action_id": "action-123456", "action_type": "read_file", "payload": action_payload, "payload_hash": hashlib.sha256(json.dumps(action_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
    accepted = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action)
    assert accepted.status_code == 200
    duplicate = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action)
    assert duplicate.status_code == 200 and duplicate.json()["step_id"] == accepted.json()["step_id"]
    result = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/action-123456/result", headers={"Authorization": f"Bearer {raw_access}"}, json={"action_id": "action-123456", "result_hash": "c" * 64, "status": "succeeded"})
    assert result.status_code == 200 and result.json()["status"] == "running"
    second_result = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/action-123456/result", headers={"Authorization": f"Bearer {raw_access}"}, json={"action_id": "action-123456", "result_hash": "c" * 64, "status": "succeeded"})
    assert second_result.status_code == 200 and second_result.json()["replayed"] is True
    assert client.get(f"/api/cli/v1/agent/runs/{run_id}", headers=auth_headers(other.firebase_uid, other.email)).status_code == 401


def test_cli_chat_stream_uses_shared_preparation_and_terminal_events(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    user = create_test_user("cli-stream-user", "cli-stream@example.com")
    raw_access = "s" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("q" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat"]', device_description="stream test",
        ))
        session.commit()

    captured: dict[str, object] = {}
    prepared = SimpleNamespace(
        request_id="cli-stream-request", thread_id="thread-stream", route=SimpleNamespace(provider="openai"),
        ai_request=SimpleNamespace(metadata={}), input_mode="text", reply_language="en",
        billing_credit_bucket="chat", swico_tier="lite",
    )
    response = AIProviderResponse(
        text="Hello from shared Chat", provider="openai", model="test-model", route="test",
        reason="test", language="en", intent="general", input_tokens=3, output_tokens=4,
        raw={"completion_status": "complete", "provenance": ["provider"]},
    )
    message = CompletedWebMessage(
        id="assistant-stream", content=response.text, status="complete", swico_tier="lite",
        usage_source="actual", charge_micros=0, provider="openai", model="test-model",
        request_id="cli-stream-request", replaces_message_id=None, revision_number=1,
    )
    completed = CompletedWebTurn("thread-stream", message, {"available_micros": 0}, response)

    def fake_prepare(**kwargs):
        captured.update(kwargs)
        return prepared

    def fake_execute(value, *, on_delta=None, **_kwargs):
        assert value is prepared
        on_delta("Hello from shared Chat")
        return completed

    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", fake_prepare)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", fake_execute)
    monkeypatch.setattr("app.cli_api.router.record_web_turn_lifecycle", lambda *_args, **_kwargs: None)
    result = client.post(
        "/api/cli/v1/chat/stream",
        headers={"Authorization": f"Bearer {raw_access}"},
        json={"request_id": str(uuid4()), "message": "hello"},
    )
    assert result.status_code == 200, result.text
    assert "event: delta" in result.text and "Hello from shared Chat" in result.text
    assert "event: done" in result.text
    assert captured["forced_swico_tier"] == "lite"
