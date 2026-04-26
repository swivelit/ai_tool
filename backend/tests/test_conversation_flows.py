from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.database import SessionLocal
import app.main as main_module
from app.main import _get_job_queue
from app.models import Item
from conftest import auth_headers, create_test_user


@pytest.fixture()
def pipeline_stub(monkeypatch):
    # Keep chat-flow tests deterministic and offline. Without this, greetings can
    # be answered by the local fast path or the orchestrator can call live OpenAI.
    monkeypatch.setattr(
        "app.main.run_orchestrator",
        lambda client, text: {
            "intent": "GENERAL",
            "priority": "low",
            "confidence": 1.0,
            "matched_keyword": "",
        },
    )
    monkeypatch.setattr("app.main.upsert_qa_cache", lambda *args, **kwargs: None)
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
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

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
        headers={**headers, "x-request-id": "req-text-001"},
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

    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    with client.stream("POST", "/api/chat/stream", headers=headers, json={"message": "hi", "reply_language": "en"}) as response:
        assert response.status_code == 200
        raw = "".join(response.iter_text())

    assert "event: status" in raw
    assert "event: token" in raw
    assert "event: done" in raw
    assert "hello" in raw
    assert "streaming" in raw


@pytest.mark.parametrize("path", ["/transcribe-and-analyze", "/api/transcribe-and-analyze"])
def test_voice_flow_uses_chat_response_shape(client, monkeypatch, pipeline_stub, path):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr("app.main._transcribe_audio_file", lambda path, speech_language=None: "voice hello")
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
    response = client.post(f"{path}?user_id={user_id}&reply_language=en", headers=headers, files=files)
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["assistant"]["text"] == "Voice reply"
    assert payload["item"]["transcript"] == "voice hello"
    assert payload["item"]["raw_text"] == "voice hello"


def test_legacy_voice_reminder_preserves_item_fields(client, monkeypatch, pipeline_stub):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr("app.main._transcribe_audio_file", lambda path, speech_language=None: "remind me about standup")
    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": "I will remind you about Standup.",
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
            "datetime": "2026-05-01T09:00:00",
            "title": "Standup",
            "details": fallback_details,
        },
    )

    files = {"file": ("audio.m4a", b"fake-audio", "audio/m4a")}
    response = client.post(f"/transcribe-and-analyze?user_id={user_id}&reply_language=en", headers=headers, files=files)
    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["intent"] == "reminder"
    assert payload["item"]["datetime"] == "2026-05-01T09:00:00"
    assert payload["item"]["title"] == "Standup"


def test_reminder_creation_flow(client, monkeypatch, pipeline_stub):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

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
        headers=headers,
        json={"user_id": user_id, "message": "remind me for standup", "reply_language": "en"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["intent"] == "reminder"
    assert payload["item"]["datetime"] == "2026-03-28T08:00:00"
    assert payload["item"]["title"] == "Standup"


def test_async_export_job_flow(client, monkeypatch, tmp_path: Path):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")
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

    # _build_download_payload only accepts files under DOCS_BASE_DIR.
    # Keep the test's fake export isolated while matching production's path contract.
    docs_dir = tmp_path / "generated_docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("app.main.DOCS_BASE_DIR", docs_dir.resolve())

    export_file = docs_dir / "item_1.pdf"
    export_file.write_text("fake pdf")
    monkeypatch.setattr("app.main.generate_pdf", lambda item: export_file)

    response = client.post(f"/items/{item_id}/generate-pdf?background=true", headers=headers)
    assert response.status_code == 200
    job_id = response.json()["job"]["id"]

    processed = _get_job_queue()._process_one()
    assert processed is True

    status_response = client.get(f"/api/jobs/{job_id}", headers=headers)
    assert status_response.status_code == 200
    job = status_response.json()["job"]
    assert job["status"] == "completed"
    assert job["result"]["download_url"].startswith("/download/")


def test_async_chat_job_flow(client, monkeypatch, pipeline_stub):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

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
        headers=headers,
        json={"user_id": user_id, "message": "do a long task", "reply_language": "en"},
    )
    assert enqueue.status_code == 200
    job_id = enqueue.json()["job"]["id"]

    processed = _get_job_queue()._process_one()
    assert processed is True

    status_response = client.get(f"/api/jobs/{job_id}", headers=headers)
    assert status_response.status_code == 200
    payload = status_response.json()["job"]
    assert payload["status"] == "completed"
    assert payload["result"]["assistant"]["text"] == "Background reply for: do a long task"




def test_tts_retry_timeout_returns_client_readable_error(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 400
        text = "bad payload"

        def json(self):
            return {}

    calls = []

    def fake_post(*args, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return DummyResponse()
        raise main_module.requests.Timeout("retry too slow")

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    response = client.post("/api/tts", headers=headers, json={"text": "hello"})

    assert response.status_code == 504
    assert response.json()["detail"] == "TTS retry timed out."
    assert calls[0]["timeout"] == (5, 30)
    assert calls[1]["timeout"] == (5, 30)


def test_feature_flags(client, monkeypatch):
    monkeypatch.setenv("VOICE_ROUTING_MODE", "local")
    response = client.get("/api/flags")
    assert response.status_code == 200
    flags = response.json()["flags"]
    assert flags["voiceRoutingMode"] == "local"
    assert flags["streamingChatEnabled"] is True
    assert flags["asyncExportJobsEnabled"] is True
    assert isinstance(flags["vectorStoreBackend"], str)