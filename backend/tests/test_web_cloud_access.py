from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.database import SessionLocal
from app.models import CliCloudJob, CliCloudJobEvent
from app.time_utils import utc_now
from tests.conftest import auth_headers, create_test_user


def _configure_cloud(monkeypatch: pytest.MonkeyPatch, allowlist: str | None = None) -> None:
    monkeypatch.setenv("SWICO_CLI_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_AGENT_ENABLED", "true")
    monkeypatch.setenv("SWICO_CLI_CLOUD_AGENT_ENABLED", "true")
    if allowlist is None:
        monkeypatch.delenv("SWICO_CLI_AGENT_ALLOWED_EMAILS", raising=False)
    else:
        monkeypatch.setenv("SWICO_CLI_AGENT_ALLOWED_EMAILS", allowlist)


@pytest.mark.parametrize("allowlist", [None, "", "   ,  "])
def test_web_cloud_admission_requires_nonempty_agent_pilot_allowlist(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, allowlist: str | None,
):
    _configure_cloud(monkeypatch, allowlist)
    user = create_test_user("web-cloud-empty-pilot", "web-cloud-empty@example.com")
    response = client.post(
        "/api/web/cloud/jobs",
        headers=auth_headers(user.firebase_uid, user.email),
        json={"task": "inspect", "source": "task_only"},
    )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "cli_agent_pilot_required"


def test_web_cloud_admission_preserves_pilot_gate_and_public_chat(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
):
    _configure_cloud(monkeypatch, "  PILOT@EXAMPLE.COM  ")
    user = create_test_user("web-cloud-nonpilot", "other@example.com")
    denied = client.post(
        "/api/web/cloud/jobs",
        headers=auth_headers(user.firebase_uid, user.email),
        json={"task": "inspect", "source": "task_only"},
    )
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "cli_agent_pilot_required"
    threads = client.get("/api/web/threads", headers=auth_headers(user.firebase_uid, user.email))
    assert threads.status_code == 200

    pilot = create_test_user("web-cloud-pilot", "pilot@example.com")
    unavailable = client.post(
        "/api/web/cloud/jobs",
        headers=auth_headers(pilot.firebase_uid, pilot.email),
        json={"task": "inspect", "source": "task_only"},
    )
    assert unavailable.status_code == 503
    assert unavailable.json()["detail"]["code"] == "cloud_execution_unavailable"


@pytest.mark.parametrize("status", ["queued", "starting", "running", "cancelling"])
def test_web_cloud_drain_remains_available_when_admission_is_disabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, status: str,
):
    _configure_cloud(monkeypatch, "pilot@example.com")
    user = create_test_user(f"web-cloud-drain-{status}", f"drain-{status}@example.com")
    with SessionLocal() as session:
        job = CliCloudJob(
            user_id=int(user.id), request_id=str(uuid4()), source="task_only", tier="lite",
            task="inspect", task_hash="a" * 64, status=status,
            expires_at=utc_now() + timedelta(minutes=5), attempt=1,
        )
        session.add(job)
        session.flush()
        session.add(CliCloudJobEvent(job_id=job.id, sequence=0, event_type=status, payload_json="{}"))
        session.commit()
        job_id = job.id

    # Pilot closure/kill switch must not block owner control of already
    # admitted work. Admission itself is still disabled.
    monkeypatch.setenv("SWICO_CLI_AGENT_ALLOWED_EMAILS", "")
    monkeypatch.setenv("SWICO_CLI_CLOUD_AGENT_ENABLED", "false")
    headers = auth_headers(user.firebase_uid, user.email)
    assert client.get("/api/web/cloud/jobs", headers=headers).status_code == 200
    assert client.get(f"/api/web/cloud/jobs/{job_id}", headers=headers).status_code == 200
    events = client.get(f"/api/web/cloud/jobs/{job_id}/events", headers=headers)
    assert events.status_code == 200
    cancelled = client.post(f"/api/web/cloud/jobs/{job_id}/cancel", headers=headers)
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] in {"cancelled", "cancelling"}

