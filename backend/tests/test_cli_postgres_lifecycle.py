from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from types import SimpleNamespace
from threading import Event
import time
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.ai.types import AIProviderResponse
from app.cli_api.security import digest
from app.database import SessionLocal, engine
from app.models import CliAgentRun, CliAgentStep, CliPendingAction, CliSession
from app.web_api.chat_service import CompletedWebMessage, CompletedWebTurn
from app.time_utils import utc_now
from tests.conftest import create_test_user


pytestmark = pytest.mark.skipif(
    engine.dialect.name != "postgresql",
    reason="requires TEST_DATABASE_URL pointing at a disposable PostgreSQL database",
)


def enable_agent_pilot(monkeypatch: pytest.MonkeyPatch, *users) -> None:
    """Explicitly admit only the synthetic users used by this test."""
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    emails = {
        str(user.email).strip().casefold()
        for user in users
        if getattr(user, "email", None)
    }
    assert emails
    monkeypatch.setenv("SWICO_CLI_AGENT_ALLOWED_EMAILS", ",".join(sorted(emails)))


def test_postgres_agent_step_reservation_serializes_concurrent_workers():
    """The run row lock serializes reservations without spanning model I/O."""
    user = create_test_user(f"cli-pg-{uuid4()}", f"cli-pg-{uuid4()}@example.test")
    with SessionLocal() as session:
        run = CliAgentRun(
            user_id=int(user.id), request_id=str(uuid4()), tier="lite", max_steps=8,
            task_hash="a" * 64, status="running", expires_at=utc_now(),
        )
        # Use a future expiration without depending on the route's configured
        # lifetime; this test is about PostgreSQL reservation semantics.
        from datetime import timedelta
        run.expires_at = utc_now() + timedelta(minutes=5)
        session.add(run)
        session.commit()
        session.refresh(run)
        run_id = run.id

    def reserve_one() -> None:
        with SessionLocal() as session:
            locked = session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id).with_for_update()).one()
            current = locked.current_step
            time.sleep(0.05)
            locked.current_step = current + 1
            session.add(locked)
            session.commit()

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _item: reserve_one(), range(2)))
    with SessionLocal() as session:
        assert session.get(CliAgentRun, run_id).current_step == 2


def test_postgres_production_route_lifecycle_binds_plan_action_result_once(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """The PostgreSQL job exercises the actual FastAPI route/service path."""
    monkeypatch.setenv("SWICO_CLI_MAX_AGENT_STEPS", "1")
    user = create_test_user(f"cli-pg-route-{uuid4()}", f"cli-pg-route-{uuid4()}@example.test")
    enable_agent_pilot(monkeypatch, user)
    raw_access = "p" * 64
    with SessionLocal() as session:
        session.add(CliSession(user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access), access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("q" * 64), refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1), selected_tier="lite", scopes_json='["chat","agent"]', device_description="postgres route"))
        session.commit()
    response = AIProviderResponse(text="", provider="test", model="test", route="test", reason="test", language="en", intent="coding", input_tokens=1, output_tokens=1, raw={"completion_status": "complete"})
    message = CompletedWebMessage(id="pg-plan-message", content=json.dumps({"kind": "action", "protocol_version": 1, "action_id": "pg-action-1", "action_type": "list_files", "payload": {"limit": 1}}), status="complete", swico_tier="lite", usage_source="actual", charge_micros=0, provider="test", model="test", request_id="pg-plan-request", replaces_message_id=None, revision_number=1)
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", lambda **_kwargs: SimpleNamespace(request_id="pg-plan-request"))
    execute_calls = 0
    def fake_execute(*_args, **_kwargs):
        nonlocal execute_calls
        execute_calls += 1
        return CompletedWebTurn(None, message, {"available_micros": 0}, response)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", fake_execute)
    monkeypatch.setattr("app.cli_api.router._redact_planner_turn", lambda *_args: None)
    headers = {"Authorization": f"Bearer {raw_access}"}
    run = client.post("/api/cli/v1/agent/runs", headers=headers, json={"request_id": str(uuid4()), "task": "inspect"})
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]
    planned = client.post(f"/api/cli/v1/agent/runs/{run_id}/plan", headers=headers, json={"task": "inspect", "context": "bounded"})
    assert planned.status_code == 200, planned.text
    body = planned.json()
    action = {"protocol_version": body["protocol_version"], "action_id": body["action_id"], "action_type": body["action_type"], "payload": body["payload"], "payload_hash": body["payload_hash"], "reservation_id": body["reservation_id"]}
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers=headers, json=action).status_code == 200
    result_hash = hashlib.sha256(b"postgres-result").hexdigest()
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/{body['action_id']}/result", headers=headers, json={"action_id": body["action_id"], "result_hash": result_hash, "status": "succeeded"}).status_code == 200
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/plan", headers=headers, json={"task": "inspect", "context": "bounded"}).status_code == 429
    with SessionLocal() as session:
        observed = session.get(CliAgentRun, run_id)
        step = session.exec(select(CliAgentStep).where(CliAgentStep.run_id == run_id)).one()
        assert observed is not None and observed.current_step == 1 and step.status == "succeeded"
        assert execute_calls == 1


def test_postgres_action_replay_conflict_ownership_and_terminal_result_are_exactly_once(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """Admission/result retries reconcile on PostgreSQL without new steps."""
    monkeypatch.setenv("SWICO_CLI_MAX_AGENT_STEPS", "1")
    owner = create_test_user(f"cli-pg-replay-{uuid4()}", f"cli-pg-replay-{uuid4()}@example.test")
    other = create_test_user(f"cli-pg-other-{uuid4()}", f"cli-pg-other-{uuid4()}@example.test")
    enable_agent_pilot(monkeypatch, owner, other)
    raw_access = "t" * 64
    other_access = "u" * 64
    with SessionLocal() as session:
        session.add_all([
            CliSession(user_id=int(owner.id), client_id="swico-cli", access_token_digest=digest(raw_access), access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("v" * 64), refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1), selected_tier="lite", scopes_json='["chat","agent"]', device_description="postgres replay"),
            CliSession(user_id=int(other.id), client_id="swico-cli", access_token_digest=digest(other_access), access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("w" * 64), refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1), selected_tier="lite", scopes_json='["chat","agent"]', device_description="postgres other"),
        ])
        session.commit()
    headers = {"Authorization": f"Bearer {raw_access}"}
    run = client.post("/api/cli/v1/agent/runs", headers=headers, json={"request_id": str(uuid4()), "task": "inspect"})
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]
    payload = {"path": "src/main.py"}
    payload_hash = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    action = {"protocol_version": 1, "action_id": "pg-replay-action", "action_type": "read_file", "payload": payload, "payload_hash": payload_hash}
    accepted = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers=headers, json=action)
    assert accepted.status_code == 200, accepted.text
    duplicate = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers=headers, json=action)
    assert duplicate.status_code == 200 and duplicate.json()["step_id"] == accepted.json()["step_id"]
    conflict = {**action, "payload": {"path": "src/other.py"}, "payload_hash": hashlib.sha256(b'{"path":"src/other.py"}').hexdigest()}
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers=headers, json=conflict).status_code == 409
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers={"Authorization": f"Bearer {other_access}"}, json=action).status_code == 404
    result_payload = {"action_id": action["action_id"], "result_hash": "x" * 64, "status": "succeeded"}
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/{action['action_id']}/result", headers=headers, json=result_payload).status_code == 200
    replay = client.post(f"/api/cli/v1/agent/runs/{run_id}/actions/{action['action_id']}/result", headers=headers, json=result_payload)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    assert client.post(f"/api/cli/v1/agent/runs/{run_id}/actions", headers=headers, json={**action, "action_id": "pg-budget-action"}).status_code == 429
    with SessionLocal() as session:
        assert len(session.exec(select(CliAgentStep).where(CliAgentStep.run_id == run_id)).all()) == 1
        assert session.exec(select(CliPendingAction).where(CliPendingAction.run_id == run_id)).one().status == "submitted"


def test_postgres_cancellation_during_provider_io_rejects_late_result(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    """Cancellation can win after reservation and before provider completion."""
    user = create_test_user(f"cli-pg-cancel-{uuid4()}", f"cli-pg-cancel-{uuid4()}@example.test")
    enable_agent_pilot(monkeypatch, user)
    raw_access = "y" * 64
    with SessionLocal() as session:
        session.add(CliSession(user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access), access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("z" * 64), refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1), selected_tier="lite", scopes_json='["chat","agent"]', device_description="postgres cancellation"))
        session.commit()
    headers = {"Authorization": f"Bearer {raw_access}"}
    run = client.post("/api/cli/v1/agent/runs", headers=headers, json={"request_id": str(uuid4()), "task": "inspect"})
    assert run.status_code == 201
    run_id = run.json()["run_id"]
    entered = Event(); release = Event()
    content = json.dumps({"kind": "assistant", "text": "late"})
    response = AIProviderResponse(text=content, provider="test", model="test", route="test", reason="test", language="en", intent="coding", input_tokens=1, output_tokens=1, raw={"completion_status": "complete"})
    message = CompletedWebMessage(id="pg-cancel-message", content=content, status="complete", swico_tier="lite", usage_source="actual", charge_micros=0, provider="test", model="test", request_id="pg-cancel-request", replaces_message_id=None, revision_number=1)
    def fake_prepare(**_kwargs):
        entered.set()
        assert release.wait(5)
        return SimpleNamespace(request_id="pg-cancel-request")
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", fake_prepare)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", lambda *_args, **_kwargs: CompletedWebTurn(None, message, {"available_micros": 0}, response))
    monkeypatch.setattr("app.cli_api.router._redact_planner_turn", lambda *_args: None)
    def plan():
        return client.post(f"/api/cli/v1/agent/runs/{run_id}/plan", headers=headers, json={"task": "inspect", "context": "bounded"})
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(plan)
        assert entered.wait(5)
        assert client.post(f"/api/cli/v1/agent/runs/{run_id}/cancel", headers=headers).status_code == 200
        release.set()
        assert pending.result(timeout=5).status_code == 409
    with SessionLocal() as session:
        step = session.exec(select(CliAgentStep).where(CliAgentStep.run_id == run_id)).one()
        assert step.status == "expired"


def test_postgres_concurrent_plan_requests_do_not_generate_two_reservations(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    user = create_test_user(f"cli-pg-concurrent-{uuid4()}", f"cli-pg-concurrent-{uuid4()}@example.test")
    enable_agent_pilot(monkeypatch, user)
    raw_access = "r" * 64
    with SessionLocal() as session:
        session.add(CliSession(user_id=int(user.id), client_id="swico-cli", access_token_digest=digest(raw_access), access_expires_at=utc_now() + timedelta(minutes=10), refresh_token_digest=digest("s" * 64), refresh_expires_at=utc_now() + timedelta(days=1), max_expires_at=utc_now() + timedelta(days=1), selected_tier="lite", scopes_json='["chat","agent"]', device_description="postgres concurrent"))
        session.commit()
    run = client.post("/api/cli/v1/agent/runs", headers={"Authorization": f"Bearer {raw_access}"}, json={"request_id": str(uuid4()), "task": "inspect"})
    run_id = run.json()["run_id"]
    entered_provider = Event(); release_provider = Event()
    content = json.dumps({"kind": "assistant", "text": "done"})
    response = AIProviderResponse(text=content, provider="test", model="test", route="test", reason="test", language="en", intent="coding", input_tokens=1, output_tokens=1, raw={"completion_status": "complete"})
    message = CompletedWebMessage(id="pg-concurrent-message", content=content, status="complete", swico_tier="lite", usage_source="actual", charge_micros=0, provider="test", model="test", request_id="pg-concurrent-request", replaces_message_id=None, revision_number=1)
    def fake_prepare(**_kwargs):
        entered_provider.set()
        assert release_provider.wait(5)
        return SimpleNamespace(request_id="pg-concurrent-request")
    monkeypatch.setattr("app.cli_api.router.prepare_web_turn", fake_prepare)
    monkeypatch.setattr("app.cli_api.router.execute_web_turn", lambda *_args, **_kwargs: CompletedWebTurn(None, message, {"available_micros": 0}, response))
    monkeypatch.setattr("app.cli_api.router._redact_planner_turn", lambda *_args: None)
    headers = {"Authorization": f"Bearer {raw_access}"}
    def call_plan():
        return client.post(f"/api/cli/v1/agent/runs/{run_id}/plan", headers=headers, json={"task": "inspect", "context": "bounded"})
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(call_plan)
        assert entered_provider.wait(5)
        second = pool.submit(call_plan)
        assert second.result(timeout=5).status_code == 409
        release_provider.set()
        assert first.result(timeout=5).status_code == 200
    with SessionLocal() as session:
        assert len(session.exec(select(CliAgentStep).where(CliAgentStep.run_id == run_id)).all()) == 1
