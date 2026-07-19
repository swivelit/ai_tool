from __future__ import annotations

from decimal import Decimal

import pytest

from app.billing.errors import InsufficientCreditError
from app.billing.pricing import calculate_topup
from app.billing.service import (
    create_usage_reservation, credit_payment_once, get_wallet_summaries,
    settle_usage_reservation,
)
from app.database import SessionLocal
from app.models import PaymentOrder
from app.web_api.schemas import WebChatRequest
from app.web_api.voice_sessions import VoiceSessionConflict, VoiceTicket, VoiceTicketStore
from tests.conftest import create_test_user


def _order(user_id: int, bucket: str, suffix: str) -> PaymentOrder:
    credit, platform = calculate_topup(1000)
    return PaymentOrder(
        user_id=user_id, credit_bucket=bucket, receipt=f"bucket-{suffix}",
        provider_order_id=f"provider-{suffix}", gross_amount_paise=1000,
        credited_amount_micros=credit, platform_share_paise=platform, status="captured",
    )


def test_chat_and_voice_topups_and_usage_are_isolated(monkeypatch):
    monkeypatch.setenv("WEB_SEPARATE_VOICE_CREDITS_ENABLED", "true")
    user = create_test_user("bucket-user", "bucket@example.com")
    with SessionLocal() as session:
        chat_order = _order(int(user.id), "chat", "chat")
        voice_order = _order(int(user.id), "voice", "voice")
        session.add(chat_order); session.add(voice_order); session.flush()
        credit_payment_once(session, chat_order); credit_payment_once(session, voice_order)
        before = get_wallet_summaries(session, int(user.id))
        assert before["chat"]["balance_micros"] == 5_000_000
        assert before["voice"]["balance_micros"] == 5_000_000
        create_usage_reservation(
            session, request_id="voice-only-charge", user_id=int(user.id), thread_id=None,
            provider="sarvam", model="saaras:v3", reserved_micros=1000,
            pricing_snapshot_json="{}", usage_kind="stt",
        )
        settle_usage_reservation(
            session, request_id="voice-only-charge", provider_cost_amount=Decimal("0.001"),
            provider_cost_currency="INR", provider_cost_micros=1000, input_tokens=0,
            cached_input_tokens=0, output_tokens=0, usage_source="actual",
            pricing_snapshot_json="{}", usage_kind="stt", audio_milliseconds=120,
        )
        after = get_wallet_summaries(session, int(user.id))
        assert after["chat"]["balance_micros"] == before["chat"]["balance_micros"]
        assert after["voice"]["balance_micros"] == before["voice"]["balance_micros"] - 1000


def test_insufficient_voice_never_touches_chat_and_release_is_bucket_local(monkeypatch):
    monkeypatch.setenv("WEB_SEPARATE_VOICE_CREDITS_ENABLED", "true")
    user = create_test_user("bucket-low", "bucket-low@example.com")
    with SessionLocal() as session:
        order = _order(int(user.id), "chat", "only-chat")
        session.add(order); session.flush(); credit_payment_once(session, order)
        with pytest.raises(InsufficientCreditError):
            create_usage_reservation(
                session, request_id="no-voice", user_id=int(user.id), thread_id=None,
                provider="sarvam", model="saaras:v3", reserved_micros=1,
                pricing_snapshot_json="{}", usage_kind="stt",
            )
        wallets = get_wallet_summaries(session, int(user.id))
        assert wallets["chat"]["balance_micros"] == 5_000_000
        assert wallets["voice"]["balance_micros"] == 0


def test_ticket_is_hashed_one_use_expiring_and_concurrent_safe():
    store = VoiceTicketStore(url="")
    meta = VoiceTicket("session-a", 1, "lite", "en", False, 4_000_000_000)
    ticket = store.mint(meta, 60, 900)
    assert ticket not in repr(store._items)
    assert store.consume(ticket) == meta
    assert store.consume(ticket) is None
    with pytest.raises(VoiceSessionConflict):
        store.mint(VoiceTicket("session-b", 1, "lite", "en", False, 4_000_000_000), 60, 900)
    store.release(meta)
    assert store.mint(VoiceTicket("session-c", 1, "lite", "ta", False, 4_000_000_000), 60, 900)


def test_legacy_voice_input_deserializes_and_new_modes_validate():
    request_id = "11111111-1111-4111-8111-111111111111"
    turn_id = "22222222-2222-4222-8222-222222222222"
    legacy = WebChatRequest(request_id=request_id, message="hello", input_mode="voice", voice_turn_id=turn_id)
    assert legacy.input_mode == "voice"
    assert WebChatRequest(request_id=request_id, message="hello", input_mode="dictation", voice_turn_id=turn_id).input_mode == "dictation"
    assert WebChatRequest(request_id=request_id, message="hello", input_mode="realtime_voice", voice_turn_id=turn_id).input_mode == "realtime_voice"
