from __future__ import annotations

import os

from fastapi import HTTPException
from sqlmodel import select

from app.database import SessionLocal
from app.models import Item, WebChatMessage
from tests.conftest import auth_headers, create_test_user


def _post_audio(client, *, uid: str = "voice-user"):
    return client.post(
        "/api/web/audio/transcribe",
        headers=auth_headers(uid, f"{uid}@example.com"),
        files={"file": ("recording.webm", b"webm-audio", "audio/webm;codecs=opus")},
    )


def test_web_audio_transcription_requires_authentication(client):
    response = client.post(
        "/api/web/audio/transcribe",
        files={"file": ("recording.webm", b"audio", "audio/webm")},
    )
    assert response.status_code == 401


def test_success_returns_transcript_only_and_persists_no_chat_or_mobile_item(client, monkeypatch):
    create_test_user("voice-user", "voice-user@example.com")
    monkeypatch.setattr("app.web_api.router.transcribe_audio_file", lambda *args, **kwargs: "Editable transcript")
    response = _post_audio(client)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "transcript": "Editable transcript",
        "detected_language": "auto",
        "duration_seconds": 1.0,
    }
    with SessionLocal() as session:
        assert session.exec(select(Item)).all() == []
        assert session.exec(select(WebChatMessage)).all() == []


def test_raw_audio_is_removed_after_success(client, monkeypatch):
    create_test_user("voice-user", "voice-user@example.com")
    import app.web_api.router as router

    original_temp = router.tempfile.NamedTemporaryFile
    paths: list[str] = []

    def tracked_temp(*args, **kwargs):
        handle = original_temp(*args, **kwargs)
        paths.append(handle.name)
        return handle

    monkeypatch.setattr(router.tempfile, "NamedTemporaryFile", tracked_temp)
    monkeypatch.setattr(router, "transcribe_audio_file", lambda *args, **kwargs: "hello")
    assert _post_audio(client).status_code == 200
    assert paths and all(not os.path.exists(path) for path in paths)


def test_raw_audio_is_removed_after_failed_transcription(client, monkeypatch):
    create_test_user("voice-user", "voice-user@example.com")
    import app.web_api.router as router

    original_temp = router.tempfile.NamedTemporaryFile
    paths: list[str] = []

    def tracked_temp(*args, **kwargs):
        handle = original_temp(*args, **kwargs)
        paths.append(handle.name)
        return handle

    monkeypatch.setattr(router.tempfile, "NamedTemporaryFile", tracked_temp)
    monkeypatch.setattr(router, "transcribe_audio_file", lambda *args, **kwargs: (_ for _ in ()).throw(
        HTTPException(502, "STT provider unavailable")
    ))
    response = _post_audio(client)
    assert response.status_code == 502
    assert paths and all(not os.path.exists(path) for path in paths)


def test_unsupported_audio_and_max_duration_are_rejected(client, monkeypatch):
    create_test_user("voice-user", "voice-user@example.com")
    unsupported = client.post(
        "/api/web/audio/transcribe",
        headers=auth_headers("voice-user", "voice-user@example.com"),
        files={"file": ("recording.ogg", b"audio", "audio/ogg")},
    )
    assert unsupported.status_code == 422
    called = {"value": False}
    monkeypatch.setattr("app.web_api.router.estimate_audio_duration_details", lambda *args: (301.0, "test"))
    monkeypatch.setattr("app.web_api.router.transcribe_audio_file", lambda *args, **kwargs: called.update(value=True))
    too_long = _post_audio(client)
    assert too_long.status_code == 413
    assert too_long.json()["error"]["code"] == "audio_too_long"
    assert called["value"] is False


def test_legacy_mobile_transcription_endpoint_still_runs_original_pipeline(client, monkeypatch):
    user = create_test_user("legacy-voice", "legacy-voice@example.com")
    monkeypatch.setattr("app.main._transcribe_audio_file", lambda *args, **kwargs: "hello")
    monkeypatch.setattr("app.main._ai_router_enabled", lambda: True)
    monkeypatch.setattr(
        "app.main.run_text_turn",
        lambda *args, **kwargs: __import__("app.ai.types", fromlist=["AIProviderResponse"]).AIProviderResponse(
            text="legacy answer", provider="blocked", model=None, route="test", reason="test",
            language="en", intent="greeting",
        ),
    )
    response = client.post(
        f"/api/transcribe-and-analyze?user_id={user.id}&reply_language=en",
        headers=auth_headers("legacy-voice", "legacy-voice@example.com"),
        files={"file": ("recording.m4a", b"audio", "audio/m4a")},
    )
    assert response.status_code == 200
    assert "assistant" in response.json() and "item" in response.json()
