from __future__ import annotations

import logging
from unittest.mock import Mock

from fastapi import HTTPException

import app.main as main_module
from app.database import SessionLocal
from app.models import Conversation, Item, QACache, RagEmbedding
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
    assert bad_type.status_code == 400

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


def test_sarvam_stt_success_is_used_by_transcribe_and_analyze(client, monkeypatch):
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


def test_sarvam_stt_timeout_returns_504(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    def fake_post(*args, **kwargs):
        raise main_module.requests.Timeout("slow provider")

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en",
        headers=headers,
        files={"file": ("audio.m4a", b"audio", "audio/m4a")},
    )

    assert response.status_code == 504
    assert response.json()["detail"] == "STT provider timed out."


def test_sarvam_stt_provider_error_redacts_backend_key(client, monkeypatch):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 401
        text = "api-subscription-key=test-key"

        def json(self):
            return {"error": {"message": "invalid test-key api-subscription-key=test-key"}}

    monkeypatch.setattr(main_module.requests, "post", lambda *args, **kwargs: DummyResponse())

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
        return DummyResponse(200, {"audios": ["YWJj"]})

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello", "target_language_code": "en-IN"},
    )

    assert response.status_code == 200
    assert response.json()["audio_base64"] ==  "YWJj"
    assert calls[0]["json"]["text"] == "hello"
    assert calls[0]["json"]["target_language_code"] == "en-IN"
    assert calls[0]["json"]["speaker"] == "shubh"
    assert calls[0]["json"]["model"] == "bulbul:v3"
    assert "inputs" not in calls[0]["json"]
    assert calls[0]["timeout"] == (5, 30)

def test_tts_accepts_audio_field(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "audio": "YWJj"
            }

    monkeypatch.setattr(
        main_module.requests,
        "post",
        lambda *args, **kwargs: DummyResponse(),
    )

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "audio_base64": "YWJj"
    }


def test_tts_accepts_audio_base64_field(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "audio_base64": "YWJj"
            }

    monkeypatch.setattr(
        main_module.requests,
        "post",
        lambda *args, **kwargs: DummyResponse(),
    )

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "audio_base64": "YWJj"
    }


def test_tts_accepts_nested_audio_field(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "data": {
                    "audio": "YWJj"
                }
            }

    monkeypatch.setattr(
        main_module.requests,
        "post",
        lambda *args, **kwargs: DummyResponse(),
    )

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "audio_base64": "YWJj"
    }

def test_tts_invalid_json_returns_502(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 200
        text = "invalid"

        def json(self):
            raise ValueError("bad json")

    monkeypatch.setattr(
        main_module.requests,
        "post",
        lambda *args, **kwargs: DummyResponse(),
    )

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello"},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "TTS provider returned invalid JSON."

def test_tts_missing_audio_returns_502(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "audios": []
            }

    monkeypatch.setattr(
        main_module.requests,
        "post",
        lambda *args, **kwargs: DummyResponse(),
    )

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello"},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "TTS provider response did not contain audio."

def test_tts_invalid_base64_returns_502(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "audio": "%%%invalid%%%"
            }

    monkeypatch.setattr(
        main_module.requests,
        "post",
        lambda *args, **kwargs: DummyResponse(),
    )

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello"},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "TTS provider returned invalid audio encoding."

def test_tts_timeout_returns_504(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    def fake_post(*args, **kwargs):
        raise main_module.requests.Timeout("slow provider")

    monkeypatch.setattr(
        main_module.requests,
        "post",
        fake_post,
    )

    response = client.post(
        "/api/tts",
        headers=headers,
        json={"text": "hello"},
    )

    assert response.status_code == 504
    assert response.json()["detail"] == "TTS provider timed out."



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
