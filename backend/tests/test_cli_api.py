from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timedelta, timezone
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
from app.models import CliAgentRun, CliAgentStep, CliCloudJob, CliCloudJobEvent, CliDeviceGrant, CliPendingAction, CliSession, User, WalletAccount
from app.cli_api.security import digest
from app.cli_api.runner_attestation import make_test_attestation
from app.time_utils import utc_now
from tests.conftest import auth_headers, create_test_user


def _verifier() -> str:
    return base64.urlsafe_b64encode(b"v" * 48).rstrip(b"=").decode()


def _challenge(value: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(value.encode()).digest()).rstrip(b"=").decode()


def test_cli_health_reports_public_rollout_without_device_or_provider_request(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "false")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_CLOUD_AGENT_ENABLED", "true")
    response = client.get("/api/cli/v1/health")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "status": "ok", "cli_enabled": False, "agent_enabled": False,
        "cloud_agent_enabled": False, "message": "Swico CLI is disabled.",
    }
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    enabled = client.get("/api/cli/v1/health")
    assert enabled.status_code == 200
    assert enabled.json()["cli_enabled"] is True
    assert enabled.json()["agent_enabled"] is True
    assert enabled.json()["cloud_agent_enabled"] is True


def test_agent_pilot_restriction_preserves_chat_for_nonpilot_user(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ALLOWED_EMAILS", "pilot@example.com")
    user = create_test_user("cli-nonpilot-chat", "chat-only@example.com")
    raw_access = "a" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("b" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat", "agent"]', device_description="pilot boundary",
        ))
        session.commit()

    denied = client.post(
        "/api/cli/v1/agent/runs",
        headers={"Authorization": f"Bearer {raw_access}"},
        json={"request_id": str(uuid4()), "task": "inspect"},
    )
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "cli_agent_pilot_required"
    assert client.get("/api/cli/v1/me", headers={"Authorization": f"Bearer {raw_access}"}).status_code == 200


def _start(client: TestClient, *, scopes: list[str] | None = None):
    verifier = _verifier()
    response = client.post("/api/cli/v1/device", json={
        "client_id": "swico-cli", "code_challenge": _challenge(verifier),
        "device_description": "Test terminal", "scopes": scopes or ["chat"],
    })
    assert response.status_code == 200, response.text
    return verifier, response.json()


@pytest.mark.parametrize("tier", ["lite", "standard", "pro"])
def test_cli_is_paid_only_and_explicit_tier_selection_does_not_change_website_preference(client: TestClient, monkeypatch: pytest.MonkeyPatch, tier: str):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_PRO_ENABLED", "true")
    user = create_test_user(f"cli-free-choice-{tier}", f"cli-free-choice-{tier}@example.com")
    from app.models import WebUsagePreferences
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), assistant_tier="free"))
        session.commit()
    verifier = _verifier()
    device = client.post("/api/cli/v1/device", json={
        "client_id": "swico-cli", "code_challenge": _challenge(verifier),
        "device_description": "Paid CLI test", "scopes": ["chat"], "tier": tier,
    })
    assert device.status_code == 200, device.text
    info = client.get(f"/api/cli/v1/device/{device.json()['user_code']}")
    assert info.status_code == 200 and info.json()["tier"] == tier
    # Approval is performed by the authenticated account in the browser.
    approved = client.post("/api/cli/v1/device/approve", json={"user_code": device.json()["user_code"], "approved": True}, headers=auth_headers(user.firebase_uid, user.email))
    assert approved.status_code == 200, approved.text
    token = client.post("/api/cli/v1/token", json={"grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": device.json()["device_code"], "code_verifier": verifier})
    assert token.status_code == 200 and token.json()["tier"] == tier
    with SessionLocal() as session:
        preference = session.exec(select(WebUsagePreferences).where(WebUsagePreferences.user_id == int(user.id))).first()
        assert preference is not None and preference.assistant_tier == "free"


def test_cli_rejects_legacy_free_contract_and_sessions_before_ai_or_billing(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    user = create_test_user("cli-legacy-free", "cli-legacy-free@example.com")
    raw_access = "f" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("r" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="free", scopes_json='["chat"]', device_description="legacy",
        ))
        session.commit()
    response = client.post("/api/cli/v1/chat/stream", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "message": "hello"})
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "cli_paid_tier_required"


def test_cli_rejects_free_device_tier_before_creating_a_grant(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    response = client.post("/api/cli/v1/device", json={
        "client_id": "swico-cli", "code_challenge": _challenge(_verifier()),
        "device_description": "invalid Free terminal", "scopes": ["chat"], "tier": "free",
    })
    # The strict request contract rejects legacy Free before the route can
    # create a pending grant or reach any billing/provider code.
    assert response.status_code == 422
    with SessionLocal() as session:
        assert session.exec(select(CliDeviceGrant)).first() is None


def test_cli_tier_switch_rejects_free_before_mutating_session(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    user = create_test_user("cli-tier-switch", "cli-tier-switch@example.com")
    raw_access = "t" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("s" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat"]', device_description="switch",
        ))
        session.commit()
    response = client.patch("/api/cli/v1/session/tier", headers={"Authorization": f"Bearer {raw_access}"}, json={"tier": "free"})
    assert response.status_code == 422


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
    usage = client.get("/api/cli/v1/usage", headers={"Authorization": f"Bearer {tokens['access_token']}"})
    assert usage.status_code == 200, usage.text
    assert usage.json()["wallet"]["credit_bucket"] == "chat"
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


def test_website_cli_session_revoke_is_owner_scoped_idempotent_and_rejects_retained_credentials(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    owner = create_test_user("cli-session-owner", "cli-session-owner@example.com")
    other = create_test_user("cli-session-other", "cli-session-other@example.com")
    raw_access = "s" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(owner.id), client_id="swico-cli",
            access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10),
            refresh_token_digest=digest("r" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1),
            max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat"]',
            device_description="Owner terminal",
        ))
        session.commit()
        session_id = session.exec(select(CliSession).where(
            CliSession.user_id == int(owner.id)
        )).one().id

    provider_called = False

    def fail_provider(*_args, **_kwargs):
        nonlocal provider_called
        provider_called = True
        raise AssertionError("revoked credentials must fail before model/billing admission")

    monkeypatch.setattr("app.cli_api.router.execute_web_turn", fail_provider)
    owner_headers = auth_headers(owner.firebase_uid, owner.email)
    other_headers = auth_headers(other.firebase_uid, other.email)
    listed = client.get("/api/web/cli/sessions", headers=owner_headers)
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [session_id]
    assert client.delete(
        f"/api/web/cli/sessions/{session_id}", headers=other_headers,
    ).status_code == 404
    assert client.delete(
        f"/api/web/cli/sessions/{session_id}", headers=owner_headers,
    ).json() == {"status": "revoked"}
    assert client.delete(
        f"/api/web/cli/sessions/{session_id}", headers=owner_headers,
    ).json() == {"status": "revoked"}
    assert client.get(
        "/api/cli/v1/me", headers={"Authorization": f"Bearer {raw_access}"},
    ).status_code == 401
    assert client.post(
        "/api/cli/v1/token", json={
            "grant_type": "refresh_token", "refresh_token": "r" * 64,
        },
    ).status_code in {400, 401}
    assert client.post(
        "/api/cli/v1/chat/stream",
        headers={"Authorization": f"Bearer {raw_access}"},
        json={"request_id": str(uuid4()), "message": "must be rejected"},
    ).status_code == 401
    assert provider_called is False


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


def test_cloud_execution_is_explicitly_unavailable_without_an_isolated_runner(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_CLOUD_AGENT_ENABLED", "true")
    user = create_test_user("cli-cloud-owner", "cloud-owner@example.com")
    raw_access = "c" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("d" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="pro", scopes_json='["chat","agent"]', device_description="cloud test",
        ))
        session.commit()
    response = client.post("/api/cli/v1/cloud/jobs", headers={"Authorization": f"Bearer {raw_access}"}, json={"task": "inspect"})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "cloud_execution_unavailable"


def test_cloud_control_plane_is_owner_scoped_idempotent_and_cancelable(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_CLOUD_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_CLOUD_RUNNER_URL", "https://runner.example.test")
    monkeypatch.setenv("SWICO_CLI_CLOUD_RUNNER_TOKEN", "test-only-runner-token")
    monkeypatch.setenv("SWICO_CLI_CLOUD_RUNNER_ATTESTATION", make_test_attestation(secret="test-only-runner-token"))
    owner = create_test_user("cloud-control-owner", "cloud-control-owner@example.com")
    other = create_test_user("cloud-control-other", "cloud-control-other@example.com")
    raw_access, other_access = "q" * 64, "w" * 64
    with SessionLocal() as session:
        for user, access in ((owner, raw_access), (other, other_access)):
            session.add(CliSession(
                user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(access),
                access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest(access[::-1]),
                refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
                selected_tier="lite", scopes_json='["chat", "agent"]', device_description="cloud control",
            ))
        session.commit()
    request_id = str(uuid4())
    headers = {"Authorization": f"Bearer {raw_access}"}
    created = client.post("/api/cli/v1/cloud/jobs", headers=headers, json={"request_id": request_id, "task": "inspect repository"})
    assert created.status_code == 200, created.text
    assert created.json()["status"] == "queued"
    duplicate = client.post("/api/cli/v1/cloud/jobs", headers=headers, json={"request_id": request_id, "task": "inspect repository"})
    assert duplicate.status_code == 200 and duplicate.json()["id"] == created.json()["id"] and duplicate.json()["idempotent"] is True
    conflict = client.post("/api/cli/v1/cloud/jobs", headers=headers, json={"request_id": request_id, "task": "different task"})
    assert conflict.status_code == 409
    listed = client.get("/api/cli/v1/cloud/jobs", headers=headers)
    assert listed.status_code == 200 and [item["id"] for item in listed.json()["items"]] == [created.json()["id"]]
    foreign = client.get(f"/api/cli/v1/cloud/jobs/{created.json()['id']}", headers={"Authorization": f"Bearer {other_access}"})
    assert foreign.status_code == 404
    # A workspace job is not claimable until its byte snapshot has been
    # finalized; a manifest-free queued row must never reach a runner.
    runner_headers = {"X-Swico-Runner-Id": "runner-before-snapshot", "X-Swico-Runner-Token": "test-only-runner-token"}
    assert client.post("/api/cli/v1/cloud/runner/jobs/claim", headers=runner_headers, json={}).json()["job"] is None
    # Disabling admission must not strand an owner from inspecting or draining
    # an already-created job.
    monkeypatch.setenv("SWICO_CLI_CLOUD_AGENT_ENABLED", "false")
    drained = client.get(f"/api/cli/v1/cloud/jobs/{created.json()['id']}", headers=headers)
    assert drained.status_code == 200 and drained.json()["status"] == "queued"
    cancelled = client.post(f"/api/cli/v1/cloud/jobs/{created.json()['id']}/cancel", headers=headers)
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    events = client.get(f"/api/cli/v1/cloud/jobs/{created.json()['id']}/events", headers=headers)
    assert events.status_code == 200 and [event["event_type"] for event in events.json()["items"]] == ["queued", "cancel_requested"]
    with SessionLocal() as session:
        assert session.exec(select(CliCloudJob).where(CliCloudJob.user_id == int(owner.id))).all()
        assert session.exec(select(CliCloudJobEvent).where(CliCloudJobEvent.job_id == created.json()["id"])).all()


def test_cloud_runner_lease_is_authenticated_single_owner_and_replay_safe(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    for name, value in {
        "SWICO_CLI_ENABLED": "true", "SWICO_CLI_AGENT_ENABLED": "true", "SWICO_CLI_CLOUD_AGENT_ENABLED": "true",
        "SWICO_CLI_CLOUD_RUNNER_URL": "https://runner.example.test", "SWICO_CLI_CLOUD_RUNNER_TOKEN": "runner-secret",
        "SWICO_CLI_CLOUD_RUNNER_ATTESTATION": make_test_attestation(secret="runner-secret"),
    }.items(): monkeypatch.setenv(name, value)
    user = create_test_user("cloud-runner-owner", "cloud-runner-owner@example.com")
    raw_access = "z" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("y" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat", "agent"]', device_description="runner lease",
        )); session.commit()
    headers = {"Authorization": f"Bearer {raw_access}"}
    created = client.post("/api/cli/v1/cloud/jobs", headers=headers, json={"source": "task_only", "task": "lease me"})
    job_id = created.json()["id"]
    assert client.post("/api/cli/v1/cloud/runner/jobs/claim", headers={"X-Swico-Runner-Id": "runner-1", "X-Swico-Runner-Token": "wrong"}, json={}).status_code == 403
    runner_headers = {"X-Swico-Runner-Id": "runner-1", "X-Swico-Runner-Token": "runner-secret"}
    claimed = client.post("/api/cli/v1/cloud/runner/jobs/claim", headers=runner_headers, json={})
    assert claimed.status_code == 200 and claimed.json()["job"]["id"] == job_id and claimed.json()["job"]["status"] == "dispatching"
    capability = claimed.json()["runner_capability"]
    assert client.post(f"/api/cli/v1/cloud/runner/jobs/{job_id}/heartbeat", headers={**runner_headers, "X-Swico-Runner-Id": "runner-2", "X-Swico-Runner-Capability": capability}).status_code == 409
    lease_headers = {**runner_headers, "X-Swico-Runner-Capability": capability}
    completed = client.post(f"/api/cli/v1/cloud/runner/jobs/{job_id}/result", headers=lease_headers, json={"status": "completed", "result": {"changed_files": []}})
    assert completed.status_code == 200 and completed.json()["status"] == "completed"
    replay = client.post(f"/api/cli/v1/cloud/runner/jobs/{job_id}/result", headers=lease_headers, json={"status": "failed"})
    assert replay.status_code == 200 and replay.json()["idempotent"] is True and replay.json()["status"] == "completed"


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
    late_action_payload = {"path": "src/other.py"}
    late_action = {"protocol_version": 1, "action_id": "action-late", "action_type": "read_file", "payload": late_action_payload, "payload_hash": hashlib.sha256(json.dumps(late_action_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=late_action).status_code == 200
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/cancel", headers={"Authorization": f"Bearer {raw_access}"}).status_code == 200
    late_result = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/action-late/result", headers={"Authorization": f"Bearer {raw_access}"}, json={"action_id": "action-late", "result_hash": "d" * 64, "status": "succeeded"})
    assert late_result.status_code == 409
    assert client.get(f"/api/cli/v1/agent/runs/{run_id}", headers={"Authorization": f"Bearer {raw_access}"}).json()["status"] == "cancelled"
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
        json={"request_id": str(uuid4()), "message": "hello", "output_schema": {"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}, "additionalProperties": False}},
    )
    assert result.status_code == 200, result.text
    assert "event: delta" in result.text and "Hello from shared Chat" in result.text
    assert "event: done" in result.text
    assert captured["forced_swico_tier"] == "lite"
    assert captured["search_mode"] == "auto"
    assert captured["output_schema"]["required"] == ["answer"]
    assert callable(prepared.ai_request.metadata.get("steering_consumer"))


@pytest.mark.parametrize(
    ("tier", "balance", "billing_exempt", "estimate_mode"),
    [
        ("lite", 5_000_000, False, "available"),
        ("standard", 0, False, "available"),
        ("pro", 5_000_000, False, "unavailable"),
        ("lite", 5_000_000, True, "exempt"),
    ],
)
def test_cli_stream_encodes_production_wallet_envelopes(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tier: str,
    balance: int,
    billing_exempt: bool,
    estimate_mode: str,
):
    """Paid SSE usage events encode the production wallet DTO, including its timestamp."""
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_PRO_ENABLED", "true")
    fixed_now = datetime(2026, 9, 13, 12, 34, 56, 789000, tzinfo=timezone.utc)
    monkeypatch.setattr("app.billing.token_estimates.utc_now", lambda: fixed_now)
    if estimate_mode == "unavailable":
        def unavailable_prices(_tier: str):
            raise RuntimeError("pricing unavailable")
        monkeypatch.setattr("app.billing.token_estimates._reference_prices", unavailable_prices)
    user = create_test_user(f"cli-wallet-{tier}-{estimate_mode}", f"cli-wallet-{tier}-{estimate_mode}@example.com")
    raw_access = (f"{tier}{estimate_mode}" * 32)[:64]
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("w" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier=tier, scopes_json='["chat"]', device_description="wallet envelope",
        ))
        session.add(WalletAccount(user_id=int(user.id), credit_bucket="chat", balance_micros=balance))
        session.commit()
        from app.billing.service import get_wallet_summary
        wallet = get_wallet_summary(
            session, int(user.id), swico_tier=tier, billing_exempt=billing_exempt, credit_bucket="chat",
        )
    prepared = SimpleNamespace(
        request_id="cli-wallet-request", thread_id="wallet-thread", route=SimpleNamespace(provider="openai"),
        ai_request=SimpleNamespace(metadata={}), input_mode="text", reply_language="en",
        billing_credit_bucket="chat", swico_tier=tier,
    )
    response = AIProviderResponse(
        text="Wallet-safe answer", provider="server", model=None, route="test", reason="test",
        language="en", intent="general", input_tokens=3, output_tokens=4,
        raw={"completion_status": "complete", "provenance": []},
    )
    message = CompletedWebMessage(
        id="wallet-assistant", content=response.text, status="complete", swico_tier=tier,
        usage_source="actual", charge_micros=123, provider=None, model=None,
        request_id="cli-wallet-request", replaces_message_id=None, revision_number=1,
        sources=({"id": "source-1", "label": "Source", "locator": "safe", "confidence": 1.0},),
        quality={"status": "best_effort", "checks": []},
    )
    completed = CompletedWebTurn("wallet-thread", message, wallet, response)
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", lambda **_kwargs: prepared)
    def execute_with_delta(value, *, on_delta=None, **_kwargs):
        if on_delta:
            on_delta(response.text)
        return completed
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", execute_with_delta)
    monkeypatch.setattr("app.cli_api.router.record_web_turn_lifecycle", lambda *_args, **_kwargs: None)
    result = client.post(
        "/api/cli/v1/chat/stream",
        headers={"Authorization": f"Bearer {raw_access}"},
        json={"request_id": str(uuid4()), "message": "hello"},
    )
    assert result.status_code == 200, result.text
    events = [json.loads(line.removeprefix("data: ")) for line in result.text.splitlines() if line.startswith("data: ")]
    names = [line.removeprefix("event: ") for line in result.text.splitlines() if line.startswith("event: ")]
    assert names == ["thread", "status", "delta", "sources", "quality", "usage", "done"]
    assert "error" not in names
    usage = events[names.index("usage")]
    assert usage["balance_micros"] == balance
    assert isinstance(usage["available_micros"], int)
    if billing_exempt:
        assert usage["token_estimate"] is None and usage["balance_display"] == "Unlimited"
    else:
        assert usage["token_estimate"]["pricing_as_of"] == fixed_now.isoformat()
        assert usage["token_estimate"]["availability"] == estimate_mode


def test_cli_stream_delivery_failure_reports_durable_completion_without_retry(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    """A post-answer wallet encoding failure is delivery failure, not generation failure."""
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    user = create_test_user("cli-delivery-failure", "cli-delivery-failure@example.com")
    raw_access = "d" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("e" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat"]', device_description="delivery failure",
        ))
        session.commit()
    prepared = SimpleNamespace(
        request_id="cli-delivery-request", thread_id="delivery-thread", route=SimpleNamespace(provider="openai"),
        ai_request=SimpleNamespace(metadata={}), input_mode="text", reply_language="en",
        billing_credit_bucket="chat", swico_tier="lite",
    )
    response = AIProviderResponse(
        text="persisted answer", provider="server", model=None, route="test", reason="test",
        language="en", intent="general", input_tokens=1, output_tokens=1,
        raw={"completion_status": "complete", "provenance": []},
    )
    message = CompletedWebMessage(
        id="delivery-assistant", content=response.text, status="complete", swico_tier="lite",
        usage_source="actual", charge_micros=1, provider=None, model=None,
        request_id="cli-delivery-request", replaces_message_id=None, revision_number=1,
    )
    completed = CompletedWebTurn("delivery-thread", message, {"available_micros": 0}, response)
    calls = 0
    def execute(_value, **_kwargs):
        nonlocal calls
        calls += 1
        return completed
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", lambda **_kwargs: prepared)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", execute)
    monkeypatch.setattr("app.cli_api.router.record_web_turn_lifecycle", lambda *_args, **_kwargs: None)
    real_sse = __import__("app.cli_api.router", fromlist=["_sse_event"])._sse_event
    def fail_usage(name: str, payload: dict[str, object]) -> str:
        if name == "usage":
            raise TypeError("injected wallet encoding failure")
        return real_sse(name, payload)
    monkeypatch.setattr("app.cli_api.router._sse_event", fail_usage)
    result = client.post(
        "/api/cli/v1/chat/stream",
        headers={"Authorization": f"Bearer {raw_access}"},
        json={"request_id": str(uuid4()), "message": "hello"},
    )
    assert result.status_code == 200
    assert "event: error" in result.text and '"code":"delivery_failed"' in result.text
    assert '"outcome":"completed_delivery_failed"' in result.text
    assert '"retryable":false' in result.text
    assert "event: done" not in result.text
    assert calls == 1


def test_cli_output_schema_is_bounded_and_rejects_invalid_payload(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    user = create_test_user("cli-schema-validation", "schema-validation@example.com")
    raw_access = "y" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("x" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat"]', device_description="schema validation",
        ))
        session.commit()
    too_large = {"description": "x" * (65 * 1024)}
    rejected = client.post(
        "/api/cli/v1/chat/stream",
        headers={"Authorization": f"Bearer {raw_access}"},
        json={"request_id": str(uuid4()), "message": "hello", "output_schema": too_large},
    )
    assert rejected.status_code == 422


def test_agent_planner_validates_inner_action_envelope_and_uses_response_usage(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    user = create_test_user("cli-planner-user", "planner@example.com")
    raw_access = "p" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("z" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat","agent"]', device_description="planner test",
        ))
        session.commit()
    task = "inspect a project"
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": task})
    assert run.status_code == 201, run.text
    content = json.dumps({
        "kind": "action", "protocol_version": 1, "action_id": "planner-action",
        "action_type": "list_files", "payload": {"limit": 3},
    })
    response = AIProviderResponse(
        text=content, provider="openai", model="test-model", route="test", reason="test",
        language="en", intent="coding", input_tokens=11, output_tokens=7,
        raw={"completion_status": "complete"},
    )
    message = CompletedWebMessage(
        id="planner-message", content=content, status="complete", swico_tier="lite",
        usage_source="actual", charge_micros=0, provider="openai", model="test-model",
        request_id="planner-request", replaces_message_id=None, revision_number=1,
    )
    completed = CompletedWebTurn(None, message, {"available_micros": 0}, response)
    observed_steps: list[int] = []
    def fake_prepare(**kwargs):
        with SessionLocal() as inspect_session:
            observed = inspect_session.get(CliAgentRun, run.json()["run_id"])
            assert observed is not None
            observed_steps.append(observed.current_step)
        return SimpleNamespace(request_id="planner-request")
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", fake_prepare)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", lambda *_args, **_kwargs: completed)
    monkeypatch.setattr("app.cli_api.router._redact_planner_turn", lambda *_args: None)
    planned = client.post(
        f"/api/cli/v1/agent/runs/{run.json()['run_id']}/plan",
        headers={"Authorization": f"Bearer {raw_access}"},
        json={"task": task, "context": "src/main.py"},
    )
    assert planned.status_code == 200, planned.text
    assert planned.json()["action_type"] == "list_files"
    assert planned.json()["usage"] == 18
    assert observed_steps == [1]


def test_agent_planner_rechecks_cancellation_after_model_io_without_authorizing_result(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    user = create_test_user("cli-planner-cancel", "planner-cancel@example.com")
    raw_access = "k" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("l" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat","agent"]', device_description="planner cancellation",
        ))
        session.commit()
    task = "inspect a project"
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": task})
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]
    content = json.dumps({"kind": "assistant", "text": "finished"})
    response = AIProviderResponse(text=content, provider="openai", model="test-model", route="test", reason="test", language="en", intent="coding", input_tokens=1, output_tokens=1, raw={"completion_status": "complete"})
    message = CompletedWebMessage(id="planner-cancel-message", content=content, status="complete", swico_tier="lite", usage_source="actual", charge_micros=0, provider="openai", model="test-model", request_id="planner-cancel-request", replaces_message_id=None, revision_number=1)
    completed = CompletedWebTurn(None, message, {"available_micros": 0}, response)
    def fake_prepare(**kwargs):
        with SessionLocal() as cancel_session:
            current = cancel_session.get(CliAgentRun, run_id)
            assert current is not None
            current.status, current.cancellation_requested, current.terminal_reason = "cancelled", True, "test_cancelled_during_model_io"
            cancel_session.add(current)
            cancel_session.commit()
        return SimpleNamespace(request_id="planner-cancel-request")
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", fake_prepare)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", lambda *_args, **_kwargs: completed)
    monkeypatch.setattr("app.cli_api.router._redact_planner_turn", lambda *_args: None)
    planned = client.post(f"/api/cli/v1/agent/runs/{run_id}/plan", headers={"Authorization": f"Bearer {raw_access}"}, json={"task": task, "context": "bounded"})
    assert planned.status_code == 409, planned.text
    assert client.get(f"/api/cli/v1/agent/runs/{run_id}", headers={"Authorization": f"Bearer {raw_access}"}).json()["status"] == "cancelled"


@pytest.mark.parametrize("max_steps", [1, 2, 8])
def test_planner_action_reservation_counts_one_round_and_binds_submission(client: TestClient, monkeypatch: pytest.MonkeyPatch, max_steps: int):
    """A plan plus its action/result is one generation-step, not two."""
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_MAX_AGENT_STEPS", str(max_steps))
    monkeypatch.setattr("app.cli_api.router.enforce_rate_limit", lambda *_args, **_kwargs: None)
    user = create_test_user(f"cli-budget-{max_steps}", f"cli-budget-{max_steps}@example.com")
    raw_access = "b" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("c" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat","agent"]', device_description="budget",
        ))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "inspect a project"})
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]
    response = AIProviderResponse(text="", provider="test", model="test", route="test", reason="test", language="en", intent="coding", input_tokens=2, output_tokens=3, raw={"completion_status": "complete"})
    calls = 0

    def fake_prepare(**kwargs):
        return SimpleNamespace(request_id=kwargs["request_id"])

    def fake_execute(_prepared):
        nonlocal calls
        calls += 1
        action_id = f"planned-{calls:04d}"
        content = json.dumps({"kind": "action", "protocol_version": 1, "action_id": action_id, "action_type": "list_files", "payload": {"limit": 3}})
        message = CompletedWebMessage(id=f"planned-message-{calls}", content=content, status="complete", swico_tier="lite", usage_source="actual", charge_micros=0, provider="test", model="test", request_id=f"planned-request-{calls}", replaces_message_id=None, revision_number=1)
        return CompletedWebTurn(None, message, {"available_micros": 0}, response)

    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", fake_prepare)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", fake_execute)
    monkeypatch.setattr("app.cli_api.router._redact_planner_turn", lambda *_args: None)
    for expected_step in range(1, max_steps + 1):
        planned = client.post(f"/api/cli/v1/agent/runs/{run_id}/plan", headers={"Authorization": f"Bearer {raw_access}"}, json={"task": "inspect a project", "context": "bounded"})
        assert planned.status_code == 200, planned.text
        body = planned.json()
        assert body["reservation_id"]
        lost_response_retry = client.post(f"/api/cli/v1/agent/runs/{run_id}/plan", headers={"Authorization": f"Bearer {raw_access}"}, json={"task": "inspect a project", "context": "bounded"})
        assert lost_response_retry.status_code == 409
        assert calls == expected_step
        with SessionLocal() as session:
            observed = session.get(CliAgentRun, run_id)
            assert observed is not None and observed.current_step == expected_step
        action = {"protocol_version": body["protocol_version"], "action_id": body["action_id"], "action_type": body["action_type"], "payload": body["payload"], "payload_hash": body["payload_hash"], "reservation_id": body["reservation_id"]}
        accepted = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action)
        assert accepted.status_code == 200, accepted.text
        result = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/{body['action_id']}/result", headers={"Authorization": f"Bearer {raw_access}"}, json={"action_id": body["action_id"], "result_hash": hashlib.sha256(f"result-{expected_step}".encode()).hexdigest(), "status": "succeeded"})
        assert result.status_code == 200, result.text
    exhausted = client.post(f"/api/cli/v1/agent/runs/{run_id}/plan", headers={"Authorization": f"Bearer {raw_access}"}, json={"task": "inspect a project", "context": "bounded"})
    assert exhausted.status_code == 429
    assert calls == max_steps


def test_planner_assistant_response_consumes_one_reservation_without_action(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_MAX_AGENT_STEPS", "1")
    user = create_test_user("cli-assistant-budget", "cli-assistant-budget@example.com")
    raw_access = "d" * 64
    with SessionLocal() as session:
        session.add(CliSession(user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access), access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("e" * 64), refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1), selected_tier="lite", scopes_json='["chat","agent"]', device_description="assistant budget"))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "summarize"})
    assert run.status_code == 201
    content = json.dumps({"kind": "assistant", "text": "No repository action is needed."})
    response = AIProviderResponse(text=content, provider="test", model="test", route="test", reason="test", language="en", intent="coding", input_tokens=1, output_tokens=1, raw={"completion_status": "complete"})
    message = CompletedWebMessage(id="assistant-budget-message", content=content, status="complete", swico_tier="lite", usage_source="actual", charge_micros=0, provider="test", model="test", request_id="assistant-budget-request", replaces_message_id=None, revision_number=1)
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", lambda **_kwargs: SimpleNamespace(request_id="assistant-budget-request"))
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", lambda *_args, **_kwargs: CompletedWebTurn(None, message, {"available_micros": 0}, response))
    monkeypatch.setattr("app.cli_api.router._redact_planner_turn", lambda *_args: None)
    planned = client.post(f"/api/cli/v1/agent/runs/{run.json()['run_id']}/plan", headers={"Authorization": f"Bearer {raw_access}"}, json={"task": "summarize", "context": ""})
    assert planned.status_code == 200 and planned.json()["kind"] == "assistant"
    with SessionLocal() as session:
        step = session.exec(select(CliAgentStep).where(CliAgentStep.run_id == run.json()["run_id"])).one()
        assert step.status == "succeeded" and step.action_type == "assistant_response"


def test_action_replay_and_conflict_are_reconciled_before_exhausted_budget(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_MAX_AGENT_STEPS", "1")
    user = create_test_user("cli-replay-budget", "cli-replay-budget@example.com")
    raw_access = "f" * 64
    with SessionLocal() as session:
        session.add(CliSession(user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access), access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("g" * 64), refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1), selected_tier="lite", scopes_json='["chat","agent"]', device_description="replay budget"))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "inspect"})
    run_id = run.json()["run_id"]
    payload = {"limit": 1}
    action = {"protocol_version": 1, "action_id": "replay-action", "action_type": "list_files", "payload": payload, "payload_hash": hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
    accepted = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action)
    assert accepted.status_code == 200
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/replay-action/result", headers={"Authorization": f"Bearer {raw_access}"}, json={"action_id": "replay-action", "result_hash": "a" * 64, "status": "succeeded"}).status_code == 200
    replay = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action)
    assert replay.status_code == 200 and replay.json()["step_id"] == accepted.json()["step_id"]
    conflict = {**action, "payload": {"limit": 2}, "payload_hash": hashlib.sha256(json.dumps({"limit": 2}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=conflict).status_code == 409


def test_action_authorization_expiry_is_independent_of_run_lifetime(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    user = create_test_user("cli-action-expiry", "cli-action-expiry@example.com")
    raw_access = "h" * 64
    with SessionLocal() as session:
        session.add(CliSession(user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access), access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("i" * 64), refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1), selected_tier="lite", scopes_json='["chat","agent"]', device_description="action expiry"))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "inspect"})
    run_id = run.json()["run_id"]
    payload = {"limit": 1}
    action = {"protocol_version": 1, "action_id": "expiry-action", "action_type": "list_files", "payload": payload, "payload_hash": hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action).status_code == 200
    with SessionLocal() as session:
        pending = session.exec(select(CliPendingAction).where(CliPendingAction.action_id == "expiry-action")).one()
        pending.expires_at = utc_now() - timedelta(seconds=1)
        session.add(pending); session.commit()
    expired = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/expiry-action/result", headers={"Authorization": f"Bearer {raw_access}"}, json={"action_id": "expiry-action", "result_hash": "b" * 64, "status": "succeeded"})
    assert expired.status_code == 409
    with SessionLocal() as session:
        assert session.exec(select(CliPendingAction).where(CliPendingAction.action_id == "expiry-action")).one().status == "expired"


def test_subagent_action_uses_independent_metered_chat_rounds_and_bounded_context(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    user = create_test_user("cli-subagent-user", "subagent@example.com")
    raw_access = "u" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("v" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat","agent"]', device_description="subagent test",
        ))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "inspect authentication"})
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]
    tasks = [{"id": "auth", "task": "Inspect the authentication boundary."}, {"id": "tests", "task": "Identify the focused tests."}]
    action_payload = {"tasks": tasks, "context": "bounded repository observations only"}
    action = {"protocol_version": 2, "action_id": "spawn-action-1", "action_type": "spawn_subagent", "payload": action_payload}
    action["payload_hash"] = hashlib.sha256(json.dumps(action_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    accepted = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action)
    assert accepted.status_code == 200, accepted.text
    calls: list[dict[str, object]] = []
    response = AIProviderResponse(text="Independent bounded analysis", provider="openai", model="test-model", route="test", reason="test", language="en", intent="coding", input_tokens=5, output_tokens=7, raw={"completion_status": "complete"})
    message = CompletedWebMessage(id="subagent-message", content=response.text, status="complete", swico_tier="lite", usage_source="actual", charge_micros=0, provider="openai", model="test-model", request_id="subagent-request", replaces_message_id=None, revision_number=1)
    completed = CompletedWebTurn(None, message, {"available_micros": 0}, response)
    def fake_prepare(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(request_id=kwargs["request_id"])
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", fake_prepare)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", lambda *_args, **_kwargs: completed)
    monkeypatch.setattr("app.cli_api.router._redact_planner_turn", lambda *_args: None)
    result = client.post(f"/api/cli/v1/agent/runs/{run_id}/subagents", headers={"Authorization": f"Bearer {raw_access}"}, json={"action_id": "spawn-action-1", **action_payload})
    assert result.status_code == 200, result.text
    assert [item["id"] for item in result.json()["results"]] == ["auth", "tests"]
    assert len(calls) == 2
    assert all(call["forced_swico_tier"] == "lite" and call["billing_credit_bucket"] == "chat" for call in calls)
    assert all("bounded repository observations only" in call["message"] for call in calls)
    replay = client.post(f"/api/cli/v1/agent/runs/{run_id}/subagents", headers={"Authorization": f"Bearer {raw_access}"}, json={"action_id": "spawn-action-1", **action_payload})
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert len(calls) == 2


def test_agent_protocol_accepts_bounded_repository_actions_and_rejects_secret_paths(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    user = create_test_user("cli-repository-actions", "repository-actions@example.com")
    raw_access = "r" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("w" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat","agent"]', device_description="repository actions",
        ))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "inspect files"})
    assert run.status_code == 201 and run.json()["max_steps"] == 8
    run_id = run.json()["run_id"]
    payload = {"path": "src/main.py", "start": 1, "end": 20}
    action = {"protocol_version": 1, "action_id": "range-action-1", "action_type": "read_file_range", "payload": payload, "payload_hash": hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
    accepted = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action)
    assert accepted.status_code == 200, accepted.text
    bad_payload = {"path": ".env.production", "content": "not sent"}
    bad = {"protocol_version": 1, "action_id": "secret-action-1", "action_type": "create_file", "payload": bad_payload, "payload_hash": hashlib.sha256(json.dumps(bad_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
    rejected = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=bad)
    assert rejected.status_code == 422


def test_agent_protocol_v2_requires_and_bounds_mcp_actions(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    user = create_test_user("cli-mcp-protocol", "mcp-protocol@example.com")
    raw_access = "m" * 64
    with SessionLocal() as session:
        session.add(CliSession(
            user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access),
            access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("n" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite", scopes_json='["chat","agent"]', device_description="mcp protocol",
        ))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "inspect MCP"})
    assert run.status_code == 201
    run_id = run.json()["run_id"]
    payload = {"server_name": "local", "tool_name": "status", "arguments": {}}
    action = {"protocol_version": 2, "action_id": "mcp-action-1", "action_type": "mcp_tool", "payload": payload, "payload_hash": hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}
    accepted = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=action)
    assert accepted.status_code == 200, accepted.text
    legacy = {**action, "protocol_version": 1, "action_id": "mcp-action-2"}
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {raw_access}"}, json=legacy).status_code == 422
