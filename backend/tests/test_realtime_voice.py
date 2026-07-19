from __future__ import annotations

import base64
import asyncio
import json
import time

import pytest
from starlette.websockets import WebSocketDisconnect

from app.ai.providers.sarvam_streaming_provider import (
    SarvamStreamingProvider, _handshake_category,
)
from app.billing.pricing import stt_price
from app.billing.service import get_or_create_wallet
from app.database import SessionLocal
from app.models import WebUsagePreferences
from app.web_api.router import _tickets, _voice_tts_chunks
from app.web_api.realtime_voice import (
    VoiceEndpointConfig, endpoint_delay_ms, join_final_segments,
    safe_provider_category, transcript_appears_unfinished,
)
from app.web_api.voice_sessions import VoiceTicket
from tests.conftest import auth_headers, create_test_user


ORIGIN = "https://web.example.test"


def _enable(monkeypatch, *, idle: int = 60, maximum: int = 900) -> None:
    monkeypatch.setenv("WEB_REALTIME_VOICE_ENABLED", "true")
    monkeypatch.setenv("WEB_SEPARATE_VOICE_CREDITS_ENABLED", "true")
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", ORIGIN)
    monkeypatch.setenv("WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS", str(idle))
    monkeypatch.setenv("WEB_REALTIME_VOICE_MAX_SESSION_SECONDS", str(maximum))


def _session(client, uid: str, email: str):
    return client.post("/api/web/voice/sessions", headers=auth_headers(uid, email))


def _set_balance(user_id: int, bucket: str, amount: int) -> None:
    with SessionLocal() as session:
        wallet = get_or_create_wallet(session, user_id, bucket)
        wallet.balance_micros = amount
        session.add(wallet)
        session.commit()


def test_voice_session_requires_auth_and_uses_saved_tier_language(client, monkeypatch):
    _enable(monkeypatch)
    assert client.post("/api/web/voice/sessions").status_code in {401, 403}
    user = create_test_user("voice-ticket", "voice-ticket@example.com")
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", "voice-ticket@example.com")
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), assistant_tier="standard"))
        loaded = session.get(type(user), user.id)
        loaded.reply_language = "ta"
        session.add(loaded)
        session.commit()
    response = _session(client, "voice-ticket", "voice-ticket@example.com")
    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["protocol_version"] == 1
    assert body["tier"] == "standard"
    assert body["language"] == "ta"
    assert body["wallet"] == body["wallets"]["chat"]
    assert body["wallets"]["chat"]["balance_micros"] == 0
    assert body["wallets"]["voice"]["balance_micros"] == 0
    assert "user" not in body["websocket_url"]
    assert "ticket" not in body["websocket_url"]


def test_ticket_origin_reuse_and_concurrent_session_security(client, monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", "voice-security@example.com")
    create_test_user("voice-security", "voice-security@example.com")
    created = _session(client, "voice-security", "voice-security@example.com")
    assert created.status_code == 201
    body = created.json()
    assert _session(client, "voice-security", "voice-security@example.com").status_code == 409

    with pytest.raises(WebSocketDisconnect) as invalid_origin:
        with client.websocket_connect(
            f"/api/web/voice/ws?ticket={body['ticket']}", headers={"origin": "https://evil.example"}
        ):
            pass
    assert invalid_origin.value.code == 4403

    path = f"/api/web/voice/ws?ticket={body['ticket']}"
    with client.websocket_connect(path, headers={"origin": ORIGIN}) as socket:
        ready = socket.receive_json()
        assert ready["type"] == "session.ready"
        socket.send_json({"protocol_version": 1, "type": "session.close"})
        assert socket.receive_json() == {
            "protocol_version": 1, "type": "session.closed", "reason": "client_closed",
        }
    with pytest.raises(WebSocketDisconnect) as reused:
        with client.websocket_connect(path, headers={"origin": ORIGIN}):
            pass
    assert reused.value.code == 4401


def test_expired_ticket_idle_timeout_and_maximum_duration(client, monkeypatch):
    _enable(monkeypatch, idle=1, maximum=30)
    user = create_test_user("voice-timeouts", "voice-timeouts@example.com")
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", "voice-timeouts@example.com")
    expired = _tickets().mint(
        VoiceTicket("expired", int(user.id), "lite", "en", False, int(time.time()) - 1),
        60, 30,
    )
    with pytest.raises(WebSocketDisconnect) as expired_close:
        with client.websocket_connect(
            f"/api/web/voice/ws?ticket={expired}", headers={"origin": ORIGIN}
        ):
            pass
    assert expired_close.value.code == 4401

    created = _session(client, "voice-timeouts", "voice-timeouts@example.com").json()
    with client.websocket_connect(
        f"/api/web/voice/ws?ticket={created['ticket']}", headers={"origin": ORIGIN}
    ) as socket:
        socket.receive_json()
        assert socket.receive_json()["reason"] == "idle_timeout"

    _enable(monkeypatch, idle=30, maximum=1)
    created = _session(client, "voice-timeouts", "voice-timeouts@example.com").json()
    with client.websocket_connect(
        f"/api/web/voice/ws?ticket={created['ticket']}", headers={"origin": ORIGIN}
    ) as socket:
        socket.receive_json()
        assert socket.receive_json()["reason"] == "maximum_duration"


class _FakeSocket:
    def __init__(self, incoming: list[str] | None = None):
        self.incoming = incoming or []
        self.sent: list[str] = []
        self.closed = False

    async def send(self, value: str) -> None:
        self.sent.append(value)

    async def close(self) -> None:
        self.closed = True

    def __aiter__(self):
        async def values():
            for item in self.incoming:
                yield item
        return values()


def test_streaming_adapter_resolves_tamil_and_exposes_partial_final_and_audio():
    async def scenario():
        stt = _FakeSocket([
            json.dumps({"type": "partial_transcript", "data": {"transcript": "வண"}}),
            json.dumps({"type": "transcript", "data": {"transcript": "வணக்கம்", "metrics": {"audio_duration": 1.25}}}),
        ])
        audio = b"progressive-audio"
        tts = _FakeSocket([
            json.dumps({"type": "audio", "data": {"audio": base64.b64encode(audio).decode()}}),
            json.dumps({"type": "completion"}),
        ])
        urls: list[str] = []

        async def connect(url: str, **_kwargs):
            urls.append(url)
            return stt if "speech-to-text" in url else tts

        provider = SarvamStreamingProvider(connect=connect, api_key="unit-test-key")
        await provider.connect_stt("ta")
        await provider.send_audio(b"\x00\x01")
        events = [event async for event in provider.stt_events()]
        assert [event["type"] for event in events] == ["partial", "final"]
        assert events[-1]["audio_milliseconds"] == 1250
        assert "language-code=ta-IN" in urls[0]
        sent_audio = json.loads(stt.sent[0])["audio"]
        assert sent_audio["encoding"] == "pcm_s16le"
        assert sent_audio["sample_rate"] == 16000

        await provider.connect_tts("ta")
        await provider.send_tts_text(" வணக்கம்   உலகம் ")
        await provider.flush_tts()
        chunks = [chunk async for chunk in provider.tts_audio()]
        assert chunks == [audio]
        config = json.loads(tts.sent[0])
        assert config["type"] == "config"
        assert config["data"]["target_language_code"] == "ta-IN"
        assert json.loads(tts.sent[1])["data"]["text"] == "வணக்கம் உலகம்"
        await provider.close()
        assert stt.closed and tts.closed

    asyncio.run(scenario())


def test_voice_ticket_preflight_targets_voice_then_chat_and_exempt_bypasses(client, monkeypatch):
    _enable(monkeypatch)
    voice_empty = create_test_user("voice-empty", "voice-empty@example.com")
    _set_balance(int(voice_empty.id), "chat", 5_000_000)
    response = _session(client, "voice-empty", "voice-empty@example.com")
    assert response.status_code == 402
    assert response.json()["error"] == {
        "code": "insufficient_voice_credit",
        "credit_bucket": "voice",
        "required_micros": stt_price(5_000).micros,
        "available_micros": 0,
        "message": "Add Voice credits to start Voice Mode.",
    }

    chat_empty = create_test_user("chat-empty", "chat-empty@example.com")
    _set_balance(int(chat_empty.id), "voice", 5_000_000)
    response = _session(client, "chat-empty", "chat-empty@example.com")
    assert response.status_code == 402
    assert response.json()["error"]["code"] == "insufficient_chat_credit"
    assert response.json()["error"]["credit_bucket"] == "chat"
    assert response.json()["error"]["required_micros"] > 0

    exempt = create_test_user("voice-exempt", "voice-exempt@example.com")
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", "voice-exempt@example.com")
    assert _session(client, "voice-exempt", "voice-exempt@example.com").status_code == 201


def test_streaming_adapter_normalizes_vad_compatibility_errors_and_tts_final():
    async def scenario():
        stt = _FakeSocket([
            json.dumps({"type": "events", "data": {"signal_type": "START_SPEECH"}}),
            json.dumps({"type": "speech_start"}),
            json.dumps({"type": "partial_transcript", "data": {"transcript": "still"}}),
            json.dumps({"type": "events", "data": {"signal_type": "END_SPEECH"}}),
            json.dumps({"type": "speech_end"}),
            json.dumps({"type": "data", "data": {"transcript": "still speaking", "metrics": {"audio_duration": 0.75}}}),
            json.dumps({"type": "error", "data": {"code": "quota_exceeded"}}),
        ])
        progressive = b"one"
        tts = _FakeSocket([
            json.dumps({"type": "audio", "data": {"content_type": "audio/mpeg", "audio": base64.b64encode(progressive).decode()}}),
            json.dumps({"type": "event", "data": {"event_type": "final"}}),
        ])

        async def connect(url: str, **_kwargs):
            return stt if "speech-to-text" in url else tts

        provider = SarvamStreamingProvider(connect=connect, api_key="unit-test-key")
        await provider.connect_stt("en")
        events = [event async for event in provider.stt_events()]
        assert [event["type"] for event in events] == [
            "speech_start", "speech_start", "partial", "speech_end", "speech_end", "final", "provider_error",
        ]
        assert events[-2]["audio_milliseconds"] == 750
        assert events[-1]["category"] == "quota"
        await provider.connect_tts("en")
        assert [chunk async for chunk in provider.tts_audio()] == [progressive]

    asyncio.run(scenario())


def test_pause_aware_endpointing_english_tamil_punctuation_and_segments():
    config = VoiceEndpointConfig()
    assert endpoint_delay_ms("This is complete.", "en", config) == 900
    assert endpoint_delay_ms("I was thinking and", "en", config) == 1550
    assert endpoint_delay_ms("நான் நினைத்தேன் ஆனால்", "ta", config) == 1550
    assert transcript_appears_unfinished("Finished?", "en") is False
    assert transcript_appears_unfinished("இது முடிந்தது.", "ta") is False
    assert join_final_segments(["one", "two words", ""]) == "one two words"
    assert min(300, endpoint_delay_ms("brief pause", "en", config)) == 300


def test_provider_close_codes_have_safe_categories():
    assert safe_provider_category(4401) == "authentication"
    assert safe_provider_category(4429) == "quota"
    assert safe_provider_category(1002) == "protocol"
    assert safe_provider_category(1013) == "temporary"
    assert _handshake_category(401) == "authentication"
    assert _handshake_category(429) == "quota"
    assert _handshake_category(426) == "protocol"
    assert _handshake_category(503) == "temporary"


def test_reservation_race_after_open_is_targeted_once_and_releases_lock(client, monkeypatch):
    _enable(monkeypatch)
    user = create_test_user("voice-race", "voice-race@example.com")
    _set_balance(int(user.id), "chat", 5_000_000)
    _set_balance(int(user.id), "voice", 5_000_000)
    created = _session(client, "voice-race", "voice-race@example.com")
    assert created.status_code == 201
    # Simulate another transaction consuming the available Voice balance after
    # the non-mutating preflight but before the WebSocket reservation.
    _set_balance(int(user.id), "voice", 0)

    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(
            f"/api/web/voice/ws?ticket={created.json()['ticket']}", headers={"origin": ORIGIN}
        ) as socket:
            assert socket.receive_json()["state"] == "connected"
            socket.send_json({
                "protocol_version": 1, "type": "session.start",
                "audio": {"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1},
            })
            targeted = socket.receive_json()
            assert targeted["type"] == "error"
            assert targeted["code"] == "insufficient_voice_credit"
            assert targeted["credit_bucket"] == "voice"
            socket.receive_json()
    assert closed.value.code == 4451
    # A released active-session lock means the next request reaches preflight
    # and returns 402, rather than the 409 active-session conflict.
    assert _session(client, "voice-race", "voice-race@example.com").status_code == 402


def test_tts_chunks_release_complete_sentences_before_the_answer_finishes():
    chunks, pending = _voice_tts_chunks("First sentence. Second is still")
    assert chunks == ["First sentence."]
    assert pending == "Second is still"

    chunks, pending = _voice_tts_chunks(pending + " arriving! Tail", final=False)
    assert chunks == ["Second is still arriving!"]
    assert pending == "Tail"

    chunks, pending = _voice_tts_chunks(pending, final=True)
    assert chunks == ["Tail"]
    assert pending == ""
