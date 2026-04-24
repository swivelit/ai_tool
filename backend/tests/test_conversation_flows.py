from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import delete

from app.database import SessionLocal
from app.main import app, _get_job_queue
from app.models import Conversation, DailyRoutine, Item, Job, QACache, RagEmbedding, User, UserProfile


@pytest.fixture(autouse=True)
def clean_db():
    queue = _get_job_queue()
    queue.stop()
    with SessionLocal() as session:
        session.exec(delete(Job))
        session.exec(delete(RagEmbedding))
        session.exec(delete(Conversation))
        session.exec(delete(QACache))
        session.exec(delete(Item))
        session.exec(delete(DailyRoutine))
        session.exec(delete(UserProfile))
        session.exec(delete(User))
        session.commit()
    yield
    queue.stop()
    with SessionLocal() as session:
        session.exec(delete(Job))
        session.exec(delete(RagEmbedding))
        session.exec(delete(Conversation))
        session.exec(delete(QACache))
        session.exec(delete(Item))
        session.exec(delete(DailyRoutine))
        session.exec(delete(UserProfile))
        session.exec(delete(User))
        session.commit()


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        _get_job_queue().stop()
        yield test_client


def _create_user() -> int:
    with SessionLocal() as session:
        user = User(name="Test User", timezone="Asia/Kolkata", assistant_name="Elli", reply_language="en")
        session.add(user)
        session.commit()
        session.refresh(user)
        return int(user.id)


@pytest.fixture()
def pipeline_stub(monkeypatch):
    monkeypatch.setattr(
        "app.main._metadata_for_item",
        lambda session, user_id, text, fallback_details: {
            "intent": "assistant",
            "category": "Other",
            "datetime": None,
            "title": "Assistant",
            "details": fallback_details,
        },
    )


def test_text_chat_flow(client, monkeypatch, pipeline_stub):
    user_id = _create_user()

    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": f"Reply for: {message}",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )

    response = client.post(
        "/api/chat",
        headers={"x-request-id": "req-text-001"},
        json={"user_id": user_id, "message": "hello there", "reply_language": "en"},
    )
    assert response.status_code == 200
    assert response.headers["x-request-id"] == "req-text-001"

    payload = response.json()
    assert payload["ok"] is True
    assert payload["assistant"]["text"] == "Reply for: hello there"
    assert payload["item"]["intent"] == "assistant"


def test_streaming_chat_flow(client, monkeypatch):
    monkeypatch.setenv("STREAM_CHUNK_SIZE", "5")
    monkeypatch.setattr(
        "app.main._run_chat_payload",
        lambda payload: {
            "ok": True,
            "assistant": {"text": "hello streaming world"},
            "item": {"id": 1, "intent": "assistant", "category": "Other", "raw_text": "hi"},
            "pipeline": {"pipeline_version": "test"},
            "meta": {},
        },
    )

    with client.stream("POST", "/api/chat/stream", json={"message": "hi", "reply_language": "en"}) as response:
        assert response.status_code == 200
        raw = "".join(response.iter_text())

    assert "event: status" in raw
    assert "event: token" in raw
    assert "event: done" in raw
    assert "hello" in raw
    assert "streaming" in raw


def test_voice_flow(client, monkeypatch, pipeline_stub):
    user_id = _create_user()

    monkeypatch.setattr("app.main._transcribe_audio_file", lambda path: "voice hello")
    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": "Voice reply",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )

    files = {"file": ("audio.m4a", b"fake-audio", "audio/m4a")}
    response = client.post(f"/transcribe-and-analyze?user_id={user_id}&reply_language=en", files=files)
    assert response.status_code == 200
    payload = response.json()
    assert payload["assistant"]["text"] == "Voice reply"
    assert payload["transcript"] == "voice hello"


def test_reminder_creation_flow(client, monkeypatch, pipeline_stub):
    user_id = _create_user()

    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": "I will remind you tomorrow at 8 AM",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )
    monkeypatch.setattr(
        "app.main._metadata_for_item",
        lambda session, user_id, text, fallback_details: {
            "intent": "reminder",
            "category": "Work",
            "datetime": "2026-03-28T08:00:00",
            "title": "Standup",
            "details": fallback_details,
        },
    )

    response = client.post(
        "/api/chat",
        json={"user_id": user_id, "message": "remind me for standup", "reply_language": "en"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["intent"] == "reminder"
    assert payload["item"]["datetime"] == "2026-03-28T08:00:00"
    assert payload["item"]["title"] == "Standup"


def test_async_export_job_flow(client, monkeypatch, tmp_path: Path):
    user_id = _create_user()
    with SessionLocal() as session:
        item = Item(
            user_id=user_id,
            intent="assistant",
            category="Other",
            raw_text="export me",
            title="Export",
            details="Export body",
            source="text",
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        item_id = int(item.id)

    export_file = tmp_path / "item_1.pdf"
    export_file.write_text("fake pdf")
    monkeypatch.setattr("app.main.generate_pdf", lambda item: export_file)

    response = client.post(f"/items/{item_id}/generate-pdf?background=true")
    assert response.status_code == 200
    job_id = response.json()["job"]["id"]

    processed = _get_job_queue()._process_one()
    assert processed is True

    status_response = client.get(f"/api/jobs/{job_id}")
    assert status_response.status_code == 200
    job = status_response.json()["job"]
    assert job["status"] == "completed"
    assert job["result"]["download_url"].startswith("/download?path=")
    assert job["result"]["progress"] == 100
    assert job["result"]["phase"] == "completed"


def test_async_chat_job_flow(client, monkeypatch, pipeline_stub):
    user_id = _create_user()

    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": f"Background reply for: {message}",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )

    enqueue = client.post(
        "/api/chat/jobs",
        json={"user_id": user_id, "message": "do a long task", "reply_language": "en"},
    )
    assert enqueue.status_code == 200
    job_id = enqueue.json()["job"]["id"]

    processed = _get_job_queue()._process_one()
    assert processed is True

    status_response = client.get(f"/api/jobs/{job_id}")
    assert status_response.status_code == 200
    payload = status_response.json()["job"]
    assert payload["status"] == "completed"
    assert payload["result"]["assistant"]["text"] == "Background reply for: do a long task"


def test_feature_flags(client, monkeypatch):
    monkeypatch.setenv("VOICE_ROUTING_MODE", "local")
    response = client.get("/api/flags")
    assert response.status_code == 200
    flags = response.json()["flags"]
    assert flags["voiceRoutingMode"] == "local"
    assert flags["streamingChatEnabled"] is True
    assert flags["asyncExportJobsEnabled"] is True
    assert isinstance(flags["vectorStoreBackend"], str)