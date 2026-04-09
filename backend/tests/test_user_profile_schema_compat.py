from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, delete

import app.agentic_service as agentic_service_module
import app.main as main_module
from app.agentic_service import AgenticService
from app.database import SessionLocal, engine
from app.main import app, _get_job_queue
from app.models import DailyRoutine, Job, User, UserProfile


@pytest.fixture(autouse=True)
def clean_db():
    SQLModel.metadata.create_all(engine)
    queue = _get_job_queue()
    queue.stop()
    with SessionLocal() as session:
        session.exec(delete(Job))
        session.exec(delete(DailyRoutine))
        session.exec(delete(UserProfile))
        session.exec(delete(User))
        session.commit()
    yield
    queue.stop()
    with SessionLocal() as session:
        session.exec(delete(Job))
        session.exec(delete(DailyRoutine))
        session.exec(delete(UserProfile))
        session.exec(delete(User))
        session.commit()


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        _get_job_queue().stop()
        yield test_client


@pytest.fixture()
def array_schema_service(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> AgenticService:
    data_dir = tmp_path / "data"
    config_dir = tmp_path / "config"
    state_dir = data_dir / "state"
    memory_dir = data_dir / "memory"
    logs_dir = data_dir / "logs"
    profiler_schema_path = config_dir / "profiler_slots.json"
    orchestrator_path = config_dir / "orchestrator_routes.json"
    alignment_path = config_dir / "alignment_rules.json"
    memory_config_path = config_dir / "memory_rules.json"

    config_dir.mkdir(parents=True, exist_ok=True)
    profiler_schema_path.write_text(
        json.dumps(
            [
                {"id": "preferred_language", "prompt": "Language?", "type": "single"},
                {"id": "hobbies", "prompt": "Hobbies?", "type": "multi"},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(agentic_service_module, "DATA_DIR", data_dir)
    monkeypatch.setattr(agentic_service_module, "AGENT_CONFIG_DIR", config_dir)
    monkeypatch.setattr(agentic_service_module, "AGENT_STATE_DIR", state_dir)
    monkeypatch.setattr(agentic_service_module, "AGENT_MEMORY_DIR", memory_dir)
    monkeypatch.setattr(agentic_service_module, "AGENT_LOGS_DIR", logs_dir)
    monkeypatch.setattr(agentic_service_module, "AGENT_PROFILER_SCHEMA_PATH", profiler_schema_path)
    monkeypatch.setattr(agentic_service_module, "AGENT_ORCHESTRATOR_CONFIG_PATH", orchestrator_path)
    monkeypatch.setattr(agentic_service_module, "AGENT_ALIGNMENT_CONFIG_PATH", alignment_path)
    monkeypatch.setattr(agentic_service_module, "AGENT_MEMORY_CONFIG_PATH", memory_config_path)

    return AgenticService(openai_client=None, local_rag_service=None)


def test_create_user_does_not_crash_with_array_shaped_profiler_schema(
    client: TestClient,
    array_schema_service: AgenticService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main_module, "_get_agentic_service", lambda: array_schema_service)

    response = client.post(
        "/users",
        json={
            "firebase_uid": "legacy-signup-user",
            "email": "legacy@example.com",
            "name": "Legacy User",
            "place": "Chennai",
            "timezone": "Asia/Kolkata",
            "assistant_name": "Elli",
            "reply_language": "en",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["name"] == "Legacy User"

    snapshot_path = Path(agentic_service_module.AGENT_STATE_DIR) / f'{payload["id"]}_profile_snapshot.json'
    assert snapshot_path.exists()


def test_persist_profile_snapshot_supports_array_shaped_profiler_schema(
    array_schema_service: AgenticService,
) -> None:
    with SessionLocal() as session:
        user = User(name="Schema User", timezone="Asia/Kolkata", assistant_name="Elli", reply_language="en")
        session.add(user)
        session.commit()
        session.refresh(user)

        profile = UserProfile(
            user_id=int(user.id),
            answers_json=json.dumps({"preferred_language": "english"}, ensure_ascii=False),
            questions_version=1,
        )
        session.add(profile)
        session.commit()

        snapshot = array_schema_service.persist_profile_snapshot(session, int(user.id))

    assert snapshot["completed_slots"] == 1
    assert snapshot["total_slots"] == 2
    assert snapshot["missing_slots"] == ["hobbies"]
    assert snapshot["profile_answers"]["preferred_language"] == "english"
