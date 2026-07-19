from __future__ import annotations

import os
from uuid import uuid4

from fastapi import HTTPException
from sqlmodel import select

from app.database import SessionLocal
from app.billing.pricing import calculate_topup
from app.billing.service import credit_payment_once
from app.models import Item, PaymentOrder, UsageCharge, WebChatMessage
from tests.conftest import auth_headers, create_test_user


def _fund(user_id: int, bucket: str = "chat") -> None:
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=user_id, credit_bucket=bucket, receipt=f"voice-fund-{user_id}-{bucket}",
            provider_order_id=f"voice-order-{user_id}-{bucket}", gross_amount_paise=1000,
            credited_amount_micros=credit, platform_share_paise=platform,
            status="captured",
        )
        session.add(order); session.flush(); credit_payment_once(session, order); session.commit()


def _post_audio(client, *, uid: str = "voice-user", operation_id: str | None = None, voice_turn_id: str | None = None):
    return client.post(
        "/api/web/audio/transcribe",
        headers=auth_headers(uid, f"{uid}@example.com"),
        data={"operation_id": operation_id or str(uuid4()), "voice_turn_id": voice_turn_id or str(uuid4())},
        files={"file": ("recording.webm", b"webm-audio", "audio/webm;codecs=opus")},
    )


def test_web_audio_transcription_requires_authentication(client):
    response = client.post(
        "/api/web/audio/transcribe",
        files={"file": ("recording.webm", b"audio", "audio/webm")},
    )
    assert response.status_code == 401


def test_success_returns_transcript_only_and_persists_no_chat_or_mobile_item(client, monkeypatch):
    user = create_test_user("voice-user", "voice-user@example.com"); _fund(int(user.id))
    monkeypatch.setattr("app.web_api.router.transcribe_audio_file", lambda *args, **kwargs: "Editable transcript")
    response = _post_audio(client)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["transcript"] == "Editable transcript"
    assert response.json()["duration_milliseconds"] == 1000
    assert response.json()["stt_charge"]["charged_micros"] > 0
    with SessionLocal() as session:
        assert session.exec(select(Item)).all() == []
        assert session.exec(select(WebChatMessage)).all() == []
        charge = session.exec(select(UsageCharge)).one()
        assert charge.usage_kind == "stt" and charge.status == "settled"


def test_raw_audio_is_removed_after_success(client, monkeypatch):
    user = create_test_user("voice-user", "voice-user@example.com"); _fund(int(user.id))
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
    user = create_test_user("voice-user", "voice-user@example.com"); _fund(int(user.id))
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
    with SessionLocal() as session:
        assert session.exec(select(UsageCharge)).one().status == "released"


def test_unsupported_audio_and_max_duration_are_rejected(client, monkeypatch):
    user = create_test_user("voice-user", "voice-user@example.com"); _fund(int(user.id))
    unsupported = client.post(
        "/api/web/audio/transcribe",
        headers=auth_headers("voice-user", "voice-user@example.com"),
        data={"operation_id": str(uuid4()), "voice_turn_id": str(uuid4())},
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


def test_stt_duplicate_operation_is_409_without_a_second_provider_call(client, monkeypatch):
    user = create_test_user("voice-user", "voice-user@example.com"); _fund(int(user.id))
    calls = 0
    def transcribe(*args, **kwargs):
        nonlocal calls
        calls += 1
        return "once"
    monkeypatch.setattr("app.web_api.router.transcribe_audio_file", transcribe)
    operation_id = str(uuid4()); voice_turn_id = str(uuid4())
    first = _post_audio(client, operation_id=operation_id, voice_turn_id=voice_turn_id)
    second = _post_audio(client, operation_id=operation_id, voice_turn_id=voice_turn_id)
    assert first.status_code == 200 and second.status_code == 409
    assert calls == 1


def test_stt_insufficient_credit_prevents_provider_call(client, monkeypatch):
    create_test_user("voice-user", "voice-user@example.com")
    monkeypatch.setattr(
        "app.web_api.router.transcribe_audio_file",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("provider called")),
    )
    response = _post_audio(client)
    assert response.status_code == 402
    assert response.json()["error"]["code"] == "insufficient_voice_credit"


def test_separate_voice_stt_never_uses_chat_and_returns_both_wallets(client, monkeypatch):
    monkeypatch.setenv("WEB_SEPARATE_VOICE_CREDITS_ENABLED", "true")
    user = create_test_user("separate-stt", "separate-stt@example.com")
    _fund(int(user.id), "chat")
    calls = 0
    def transcribe(*args, **kwargs):
        nonlocal calls
        calls += 1
        return "editable"
    monkeypatch.setattr("app.web_api.router.transcribe_audio_file", transcribe)
    insufficient = _post_audio(client, uid="separate-stt")
    assert insufficient.status_code == 402
    assert insufficient.json()["error"]["credit_bucket"] == "voice"
    assert calls == 0
    _fund(int(user.id), "voice")
    completed = _post_audio(client, uid="separate-stt")
    assert completed.status_code == 200 and calls == 1
    body = completed.json()
    assert body["wallet"] == body["wallets"]["chat"]
    assert body["wallets"]["chat"]["balance_micros"] == 5_000_000
    assert body["wallets"]["voice"]["balance_micros"] < 5_000_000
    with SessionLocal() as session:
        assert session.exec(select(UsageCharge)).one().credit_bucket == "voice"


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
