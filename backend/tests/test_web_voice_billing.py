from __future__ import annotations

import base64
import json
from decimal import Decimal
from uuid import uuid4

from fastapi import HTTPException
from sqlmodel import select

from app.billing.pricing import calculate_topup, stt_price, tts_price
from app.billing.service import credit_payment_once, get_wallet_summary
from app.database import SessionLocal
from app.models import (
    PaymentOrder, UsageCharge, WebChatMessage, WebChatThread, WebUsagePreferences,
)
from tests.conftest import auth_headers, create_test_user


WAV_BASE64 = base64.b64encode(b"RIFF" + b"\x00" * 20).decode()


def _fund(user_id: int, bucket: str = "chat") -> int:
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=user_id, credit_bucket=bucket, receipt=f"voice-reply-fund-{user_id}-{bucket}",
            provider_order_id=f"voice-reply-order-{user_id}-{bucket}", gross_amount_paise=1000,
            credited_amount_micros=credit, platform_share_paise=platform, status="captured",
        )
        session.add(order); session.flush(); credit_payment_once(session, order); session.commit()
    return credit


def _message(
    user_id: int, *, role: str = "assistant", status: str = "complete",
    voice_turn_id: str | None = None, reply_language: str | None = "en",
    content: str = "A stored answer.",
    input_mode: str = "voice",
) -> str:
    voice_turn_id = voice_turn_id or str(uuid4())
    with SessionLocal() as session:
        thread = WebChatThread(user_id=user_id, title="Voice")
        session.add(thread); session.flush()
        metadata = {"input_mode": input_mode}
        if input_mode != "text":
            metadata["voice_turn_id"] = voice_turn_id
        if reply_language is not None:
            metadata["reply_language"] = reply_language
        message = WebChatMessage(
            thread_id=thread.id, user_id=user_id, role=role, status=status,
            content=content, request_id=str(uuid4()),
            metadata_json=json.dumps(metadata),
        )
        session.add(message); session.commit()
        return message.id


def test_text_answer_uses_request_id_for_voice_reply(client, monkeypatch):
    user = create_test_user("tts-text", "tts-text@example.com")
    _fund(int(user.id))
    message_id = _message(int(user.id), input_mode="text")
    with SessionLocal() as session:
        message = session.get(WebChatMessage, message_id)
        assert message is not None
        voice_turn_id = str(message.request_id)
    monkeypatch.setattr(
        "app.web_api.router.SarvamProvider.tts",
        lambda *args, **kwargs: WAV_BASE64,
    )
    response = _post_tts(client, "tts-text", message_id, voice_turn_id)
    assert response.status_code == 200


def _post_tts(client, uid: str, message_id: str, voice_turn_id: str, operation_id: str | None = None):
    return client.post(
        "/api/web/audio/synthesize", headers=auth_headers(uid, f"{uid}@example.com"),
        json={
            "operation_id": operation_id or str(uuid4()), "message_id": message_id,
            "voice_turn_id": voice_turn_id,
        },
    )


def test_decimal_voice_prices_round_final_micros_up(monkeypatch):
    monkeypatch.setenv("USAGE_MARKUP_MULTIPLIER", "1")
    monkeypatch.setenv("SARVAM_PRICE_STT_INR_PER_HOUR", "30")
    monkeypatch.setenv("SARVAM_PRICE_TTS_V2_INR_PER_10K_CHARS", "15")
    stt = stt_price(1000)
    tts = tts_price(10, "bulbul:v2")
    assert stt.amount == Decimal(1000) * Decimal(30) / Decimal(3_600_000)
    assert stt.micros == 8_334
    assert tts.amount == Decimal("0.015") and tts.micros == 15_000
    assert stt.snapshot["audio_milliseconds"] == 1000
    assert tts.snapshot["characters"] == 10


def test_web_voice_routes_require_authentication(client):
    stt = client.post(
        "/api/web/audio/transcribe",
        data={"operation_id": str(uuid4()), "voice_turn_id": str(uuid4())},
        files={"file": ("recording.webm", b"audio", "audio/webm")},
    )
    tts = client.post("/api/web/audio/synthesize", json={
        "operation_id": str(uuid4()), "message_id": str(uuid4()),
        "voice_turn_id": str(uuid4()),
    })
    assert stt.status_code == tts.status_code == 401


def test_tts_hides_cross_user_non_assistant_and_incomplete_messages(client, monkeypatch):
    owner = create_test_user("owner-voice", "owner-voice@example.com")
    caller = create_test_user("caller-voice", "caller-voice@example.com")
    _fund(int(caller.id))
    voice_turn = str(uuid4())
    ids = [
        _message(int(owner.id), voice_turn_id=voice_turn),
        _message(int(caller.id), role="user", voice_turn_id=voice_turn),
        _message(int(caller.id), status="streaming", voice_turn_id=voice_turn),
    ]
    monkeypatch.setattr(
        "app.web_api.router.SarvamProvider.tts", lambda *args, **kwargs: WAV_BASE64
    )
    for message_id in ids:
        response = _post_tts(client, "caller-voice", message_id, voice_turn)
        assert response.status_code == 404


def test_tts_uses_stored_language_exact_charge_and_idempotency(client, monkeypatch):
    user = create_test_user("tts-paid", "tts-paid@example.com")
    opening_balance = _fund(int(user.id))
    voice_turn = str(uuid4())
    message_id = _message(
        int(user.id), voice_turn_id=voice_turn, reply_language="ta", content="தமிழ் பதில்",
    )
    calls: list[dict] = []
    monkeypatch.setattr(
        "app.web_api.router.SarvamProvider.tts",
        lambda self, text, **kwargs: calls.append({"text": text, **kwargs}) or WAV_BASE64,
    )
    operation_id = str(uuid4())
    response = _post_tts(client, "tts-paid", message_id, voice_turn, operation_id)
    assert response.status_code == 200
    body = response.json()
    expected = tts_price(len("தமிழ் பதில்"), "bulbul:v2").micros
    assert body["target_language_code"] == "ta-IN"
    assert body["charged_micros"] == expected
    assert calls[0]["text"] == "தமிழ் பதில்" and calls[0]["target_language_code"] == "ta-IN"
    duplicate = _post_tts(client, "tts-paid", message_id, voice_turn, operation_id)
    assert duplicate.status_code == 409 and len(calls) == 1
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge)).one()
        assert charge.usage_kind == "tts" and charge.voice_turn_id == voice_turn
        assert charge.assistant_message_id == message_id and charge.characters == len("தமிழ் பதில்")
        assert get_wallet_summary(session, int(user.id))["balance_micros"] == opening_balance - expected


def test_tts_provider_failure_releases_reservation(client, monkeypatch):
    user = create_test_user("tts-fail", "tts-fail@example.com")
    opening_balance = _fund(int(user.id))
    voice_turn = str(uuid4()); message_id = _message(int(user.id), voice_turn_id=voice_turn)
    monkeypatch.setattr(
        "app.web_api.router.SarvamProvider.tts",
        lambda *args, **kwargs: (_ for _ in ()).throw(HTTPException(502, "provider failed")),
    )
    response = _post_tts(client, "tts-fail", message_id, voice_turn)
    assert response.status_code == 502
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge)).one()
        wallet = get_wallet_summary(session, int(user.id))
        assert charge.status == "released"
        assert wallet["balance_micros"] == opening_balance and wallet["reserved_micros"] == 0


def test_tts_insufficient_credit_and_monthly_limit_prevent_provider(client, monkeypatch):
    called = 0
    def provider(*args, **kwargs):
        nonlocal called
        called += 1
        return WAV_BASE64
    monkeypatch.setattr("app.web_api.router.SarvamProvider.tts", provider)
    no_credit = create_test_user("tts-empty", "tts-empty@example.com")
    voice_turn = str(uuid4()); message_id = _message(int(no_credit.id), voice_turn_id=voice_turn)
    response = _post_tts(client, "tts-empty", message_id, voice_turn)
    assert response.status_code == 402 and response.json()["error"]["code"] == "insufficient_voice_credit"

    limited = create_test_user("tts-limit", "tts-limit@example.com")
    _fund(int(limited.id)); limited_turn = str(uuid4())
    limited_message = _message(int(limited.id), voice_turn_id=limited_turn)
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(limited.id), hard_limit_micros=1))
        session.commit()
    response = _post_tts(client, "tts-limit", limited_message, limited_turn)
    assert response.status_code == 402 and response.json()["error"]["code"] == "usage_limit_reached"
    assert called == 0


def test_separate_voice_tts_debits_voice_only_and_preserves_stored_text(client, monkeypatch):
    monkeypatch.setenv("WEB_SEPARATE_VOICE_CREDITS_ENABLED", "true")
    user = create_test_user("separate-tts", "separate-tts@example.com")
    _fund(int(user.id), "chat")
    turn = str(uuid4()); message_id = _message(int(user.id), voice_turn_id=turn)
    calls = 0
    def provider(*args, **kwargs):
        nonlocal calls
        calls += 1
        return WAV_BASE64
    monkeypatch.setattr("app.web_api.router.SarvamProvider.tts", provider)
    insufficient = _post_tts(client, "separate-tts", message_id, turn)
    assert insufficient.status_code == 402
    assert insufficient.json()["error"]["credit_bucket"] == "voice"
    assert calls == 0
    _fund(int(user.id), "voice")
    completed = _post_tts(client, "separate-tts", message_id, turn)
    assert completed.status_code == 200 and calls == 1
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge)).one()
        message = session.get(WebChatMessage, message_id)
        assert charge.credit_bucket == "voice"
        assert message is not None and message.content == "A stored answer."
        assert get_wallet_summary(session, int(user.id), credit_bucket="chat")["balance_micros"] == 5_000_000
        assert get_wallet_summary(session, int(user.id), credit_bucket="voice")["balance_micros"] < 5_000_000


def test_tts_billing_exempt_user_is_audited_without_wallet_debit(client, monkeypatch):
    email = "tts-exempt@example.com"
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", email)
    user = create_test_user("tts-exempt", email)
    voice_turn = str(uuid4()); message_id = _message(int(user.id), voice_turn_id=voice_turn)
    monkeypatch.setattr("app.web_api.router.SarvamProvider.tts", lambda *args, **kwargs: WAV_BASE64)
    response = client.post(
        "/api/web/audio/synthesize", headers=auth_headers("tts-exempt", email),
        json={"operation_id": str(uuid4()), "message_id": message_id, "voice_turn_id": voice_turn},
    )
    assert response.status_code == 200 and response.json()["charged_micros"] == 0
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge)).one()
        assert charge.status == "billing_exempt" and charge.provider_cost_micros > 0
