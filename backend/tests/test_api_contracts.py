from __future__ import annotations

import logging
from unittest.mock import Mock

from fastapi import HTTPException

import app.main as main_module
from app.database import SessionLocal
from app.models import Item
from conftest import auth_headers, create_test_user


def _stub_chat_pipeline(
    monkeypatch,
    *,
    assistant_text: str = "Test assistant reply",
    intent: str = "assistant",
    title: str = "Assistant",
    datetime: str | None = None,
):
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


def test_tts_retries_legacy_payload_and_returns_audio(client, monkeypatch):
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
        if len(calls) == 1:
            return DummyResponse(400, text="bad payload")
        return DummyResponse(200, {"audios": ["base64-audio"]})

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    response = client.post("/api/tts", headers=headers, json={"text": "hello"})

    assert response.status_code == 200
    assert response.json()["audio_base64"] == "base64-audio"
    assert "inputs" in calls[0]["json"]
    assert "text" in calls[1]["json"]
    assert calls[0]["timeout"] == (5, 30)
    assert calls[1]["timeout"] == (5, 30)


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
