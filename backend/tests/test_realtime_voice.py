from __future__ import annotations

import base64
import asyncio
import json
import time
import logging
from urllib.parse import parse_qs, urlsplit

import pytest
from starlette.websockets import WebSocketDisconnect

from app.ai.providers.sarvam_streaming_provider import (
    SarvamStreamingProvider, _handshake_category, sarvam_stt_message_encoding,
    sarvam_tts_output_codec, sarvam_tts_sample_rate,
)
from app.billing.pricing import stt_price
from app.billing.service import get_or_create_wallet
from app.database import SessionLocal
from app.models import WebUsagePreferences
from app.web_api.router import (
    _tickets, _voice_audio_end, _voice_audio_start, _voice_playback_selection,
    _voice_backchannel_due, _voice_llm_preflight_micros, _voice_tts_chunks,
)
from app.web_api.adaptive_endpointing import TranscriptClassification
from app.web_api.realtime_voice import (
    VoiceEndpointConfig, VoiceState, endpoint_delay_ms, join_final_segments,
    safe_provider_category, transcript_appears_unfinished,
)
from app.web_api.voice_sessions import VoiceSessionConflict, VoiceTicket, VoiceTicketStore
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
    assert body["playback_mode"] == "buffered_mp3"
    assert body["selected_codec"] == "mp3"
    assert body["provider_sample_rate"] is None
    assert body["media_source_allowed"] is False
    assert "user" not in body["websocket_url"]
    assert "ticket" not in body["websocket_url"]


def test_auto_session_accepts_only_bounded_capabilities(client, monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", "voice-auto@example.com")
    monkeypatch.setenv("WEB_REALTIME_VOICE_PLAYBACK_MODE", "auto")
    monkeypatch.setenv("SARVAM_TTS_STREAM_OUTPUT_CODEC", "linear16")
    create_test_user("voice-auto", "voice-auto@example.com")
    response = client.post(
        "/api/web/voice/sessions", headers=auth_headers("voice-auto", "voice-auto@example.com"),
        json={"browser_capabilities": {"web_audio": True, "media_source": True, "media_source_mp3": True}},
    )
    assert response.status_code == 201
    assert response.json()["playback_mode"] == "pcm_stream"
    assert response.json()["selected_codec"] == "linear16"
    assert response.json()["provider_sample_rate"] == 24000


def test_internal_voice_diagnostics_are_safe_and_hidden_from_normal_users(client, monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setenv("WEB_VOICE_BILLING_ENABLED", "true")
    monkeypatch.setenv("SARVAM_API_KEY", "sarvam-super-secret")
    monkeypatch.setenv("DATABASE_URL", "postgresql://secret-database")
    monkeypatch.setenv("WEB_UPLOAD_CACHE_URL", "redis://secret-valkey")
    monkeypatch.setenv("RENDER_GIT_COMMIT", "208e3024abcdef")
    create_test_user("voice-normal", "voice-normal@example.com")
    hidden = client.get(
        "/api/web/voice/diagnostics", headers={**auth_headers("voice-normal", "voice-normal@example.com"), "origin": ORIGIN},
    )
    assert hidden.status_code == 404
    assert hidden.headers["cache-control"] == "no-store"

    email = "voice-diagnostic@example.com"
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", email)
    create_test_user("voice-diagnostic", email)

    class Store:
        configured = True
        @staticmethod
        def reachable():
            return True

    monkeypatch.setattr("app.web_api.router._tickets", lambda: Store())
    response = client.get(
        "/api/web/voice/diagnostics", headers={**auth_headers("voice-diagnostic", email), "origin": ORIGIN},
    )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["backend_release"] == "208e3024abcd"
    assert body["alembic_head"] == "b4e8c1d6a2f9"
    assert body["authentication"] == {
        "internal_test_user": True, "email_verified": True, "owned_email_matches": True,
    }
    assert body["valkey"] == {"configured": True, "reachable": True}
    assert body["wallet_preflight"]["chat"]["non_exempt_required_micros"] == 0
    assert body["wallet_preflight"]["chat"]["required_for_realtime_voice"] is False
    assert body["wallet_preflight"]["voice"]["non_exempt_required_micros"] == (
        stt_price(5_000).micros + _voice_llm_preflight_micros(body["selected_tier_id"])
    )
    assert body["wallet_preflight"]["voice"]["required_for_realtime_voice"] is True
    serialized = json.dumps(body)
    for forbidden in ("sarvam-super-secret", "secret-database", "secret-valkey", email, "firebase_uid", "ticket"):
        assert forbidden not in serialized


def test_voice_ticket_store_failure_is_stable_and_telemetry_is_content_free(client, monkeypatch, caplog):
    _enable(monkeypatch)
    email = "voice-store@example.com"
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", email)
    create_test_user("voice-store", email)

    class BrokenStore:
        def mint(self, *_args, **_kwargs):
            raise RuntimeError("redis://must-not-be-logged")

    monkeypatch.setattr("app.web_api.router._tickets", lambda: BrokenStore())
    with caplog.at_level(logging.INFO, logger="app.web_api.router"):
        response = _session(client, "voice-store", email)
    assert response.status_code == 503
    assert response.json() == {"error": {
        "code": "voice_ticket_store_unavailable",
        "message": "Voice Mode is temporarily unavailable.",
    }}
    event = next(record for record in caplog.records if record.message == "voice_session_creation")
    assert event.outcome_code == "valkey_unavailable"
    assert event.http_status == 503
    assert event.billing_exempt is True
    assert email not in caplog.text and "redis://must-not-be-logged" not in caplog.text


def test_ticket_origin_reuse_and_concurrent_session_security(client, monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setenv("SWICO_INTERNAL_TEST_EMAILS", "voice-security@example.com")
    create_test_user("voice-security", "voice-security@example.com")
    created = _session(client, "voice-security", "voice-security@example.com")
    assert created.status_code == 201
    body = created.json()
    conflict = _session(client, "voice-security", "voice-security@example.com")
    assert conflict.status_code == 409
    assert conflict.json()["error"]["retry_after_seconds"] > 0
    assert conflict.headers["retry-after"] == str(conflict.json()["error"]["retry_after_seconds"])

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


def test_voice_lock_status_is_metadata_only_and_release_is_owner_scoped(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    store = VoiceTicketStore(url="")
    first = VoiceTicket("session-one", 101, "lite", "en", True, int(time.time()) + 60)
    other = VoiceTicket("session-other", 101, "lite", "en", True, int(time.time()) + 60)
    ticket = store.mint(first, 60, 900)
    active, ttl = store.session_status(101)
    assert active is True and 0 < ttl <= 60
    store.release(other)
    assert store.session_status(101)[0] is True
    assert store.consume(ticket) == first
    store.release(first)
    assert store.session_status(101) == (False, 0)


def test_voice_conflict_force_release_then_mint_succeeds(monkeypatch):
    monkeypatch.setenv("APP_ENV", "development")
    store = VoiceTicketStore(url="")
    first = VoiceTicket("session-one", 101, "lite", "en", True, int(time.time()) + 60)
    second = VoiceTicket("session-two", 101, "lite", "en", True, int(time.time()) + 60)
    third = VoiceTicket("session-three", 101, "lite", "en", True, int(time.time()) + 60)

    store.mint(first, 60, 900)
    with pytest.raises(VoiceSessionConflict):
        store.mint(second, 60, 900)
    assert store.force_release_user(101) is True
    assert store.force_release_user(101) is False
    assert store.mint(third, 60, 900)


def test_force_release_user_redis_path_deletes_only_the_active_lock_key():
    class Redis:
        deleted: list[str] = []

        def delete(self, key: str) -> int:
            self.deleted.append(key)
            return 1 if len(self.deleted) == 1 else 0

    store = VoiceTicketStore(url="")
    redis = Redis()
    store._redis = redis

    assert store.force_release_user(204) is True
    assert store.force_release_user(204) is False
    assert redis.deleted == ["swico:voice:active:204", "swico:voice:active:204"]


def test_release_voice_session_requires_auth_is_owner_scoped_and_rate_limited(client, monkeypatch, caplog):
    assert client.delete("/api/web/voice/sessions").status_code in {401, 403}
    owner = create_test_user("voice-release-owner", "voice-release-owner@example.com")
    other = create_test_user("voice-release-other", "voice-release-other@example.com")
    store = VoiceTicketStore(url="")
    monkeypatch.setattr("app.web_api.router._tickets", lambda: store)
    store.mint(
        VoiceTicket("owner-session", int(owner.id), "lite", "en", True, int(time.time()) + 60),
        60, 900,
    )
    store.mint(
        VoiceTicket("other-session", int(other.id), "lite", "en", True, int(time.time()) + 60),
        60, 900,
    )
    headers = auth_headers("voice-release-owner", "voice-release-owner@example.com")

    with caplog.at_level(logging.INFO, logger="app.web_api.router"):
        responses = [client.delete(
            "/api/web/voice/sessions",
            headers=headers,
            params={"user_id": int(other.id)} if index == 0 else None,
        ) for index in range(10)]
    assert all(response.status_code == 204 for response in responses)
    assert responses[0].headers["cache-control"] == "no-store"
    assert store.session_status(int(owner.id)) == (False, 0)
    assert store.session_status(int(other.id))[0] is True
    limited = client.delete("/api/web/voice/sessions", headers=headers)
    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"
    events = [record for record in caplog.records if record.message == "voice_session_release"]
    assert events[0].released is True
    assert events[-1].released is False


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
        assert sent_audio["encoding"] == "audio/wav"
        assert sent_audio["sample_rate"] == 16000

        await provider.connect_tts("ta")
        await provider.ping_tts()
        await provider.send_tts_text(" வணக்கம்   உலகம் ")
        await provider.flush_tts()
        chunks = [chunk async for chunk in provider.tts_audio()]
        assert chunks == [audio]
        config = json.loads(tts.sent[0])
        assert config["type"] == "config"
        assert config["data"]["target_language_code"] == "ta-IN"
        assert config["data"]["output_audio_codec"] == "mp3"
        assert config["data"]["speech_sample_rate"] == 24000
        assert json.loads(tts.sent[1]) == {"type": "ping"}
        assert json.loads(tts.sent[2])["data"]["text"] == "வணக்கம் உலகம்"
        await provider.close()
        assert stt.closed and tts.closed

    asyncio.run(scenario())


def test_streaming_tts_exact_linear16_wire_contract_and_sample_rate(monkeypatch):
    async def scenario():
        socket = _FakeSocket([json.dumps({"type": "completion"})])
        async def connect(_url: str, **_kwargs):
            return socket
        provider = SarvamStreamingProvider(connect=connect, api_key="unit-test-key")
        await provider.connect_tts("en", output_codec="linear16", sample_rate=16000)
        config = json.loads(socket.sent[0])
        assert config["type"] == "config"
        assert config["data"]["output_audio_codec"] == "linear16"
        assert config["data"]["speech_sample_rate"] == 16000
        assert [chunk async for chunk in provider.tts_audio()] == []
        assert provider.tts_completion_received is True
    monkeypatch.setenv("SARVAM_TTS_STREAM_OUTPUT_CODEC", "mp3")
    asyncio.run(scenario())


def test_voice_playback_selection_is_server_authoritative(monkeypatch):
    monkeypatch.setenv("WEB_REALTIME_VOICE_PLAYBACK_MODE", "buffered_mp3")
    monkeypatch.setenv("SARVAM_TTS_STREAM_OUTPUT_CODEC", "mp3")
    monkeypatch.setenv("SARVAM_TTS_STREAM_SAMPLE_RATE", "24000")
    selected = _voice_playback_selection({"web_audio": True, "media_source": True, "media_source_mp3": True})
    assert selected == {
        "playback_mode": "buffered_mp3", "output_codec": "mp3", "sample_rate": 24000,
        "media_source_allowed": False,
    }
    monkeypatch.setenv("WEB_REALTIME_VOICE_PLAYBACK_MODE", "auto")
    monkeypatch.setenv("SARVAM_TTS_STREAM_OUTPUT_CODEC", "linear16")
    assert _voice_playback_selection({"web_audio": True})["output_codec"] == "linear16"
    fallback = _voice_playback_selection({"web_audio": False})
    assert fallback["output_codec"] == "mp3"
    assert fallback["playback_mode"] == "buffered_mp3"
    assert sarvam_tts_output_codec("linear16") == "linear16"
    assert sarvam_tts_sample_rate("22050") == 22050


def test_audio_start_and_end_contracts_are_exact_and_content_free():
    mp3 = VoiceTicket(
        "mp3-session", 1, "lite", "en", False, 4_000_000_000,
        "buffered_mp3", "mp3", 24000, False,
    )
    assert _voice_audio_start(mp3, 1) == {
        "content_type": "audio/mpeg", "codec": "mp3", "sample_rate": None,
        "channels": 1, "sample_format": None, "playback_mode": "buffered_mp3",
        "turn_number": 1,
    }
    pcm = VoiceTicket(
        "pcm-session", 1, "lite", "ta", True, 4_000_000_000,
        "pcm_stream", "linear16", 24000, False,
    )
    assert _voice_audio_start(pcm, 2) == {
        "content_type": "audio/L16", "codec": "linear16", "sample_rate": 24000,
        "channels": 1, "sample_format": "pcm_s16le", "playback_mode": "pcm_stream",
        "turn_number": 2,
    }
    assert _voice_audio_end(
        pcm, 2, chunks_sent=3, bytes_sent=960, characters=42, interrupted=False,
    ) == {
        "turn_number": 2, "codec": "linear16", "chunks_sent": 3,
        "bytes_sent": 960, "characters": 42, "interrupted": False,
    }


def test_voice_ticket_preflight_requires_only_combined_voice_minimum_and_exempt_bypasses(client, monkeypatch):
    _enable(monkeypatch)
    voice_empty = create_test_user("voice-empty", "voice-empty@example.com")
    _set_balance(int(voice_empty.id), "chat", 5_000_000)
    response = _session(client, "voice-empty", "voice-empty@example.com")
    assert response.status_code == 402
    assert response.json()["error"] == {
        "code": "insufficient_voice_credit",
        "credit_bucket": "voice",
        "required_micros": stt_price(5_000).micros + _voice_llm_preflight_micros("lite"),
        "available_micros": 0,
        "message": "Add Voice credits to start Voice Mode.",
    }

    chat_empty = create_test_user("chat-empty", "chat-empty@example.com")
    _set_balance(int(chat_empty.id), "voice", 5_000_000)
    response = _session(client, "chat-empty", "chat-empty@example.com")
    assert response.status_code == 201
    assert response.json()["wallets"]["chat"]["available_micros"] == 0
    assert response.json()["wallets"]["voice"]["available_micros"] == 5_000_000

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


def test_streaming_stt_contract_has_exact_query_header_and_sdk_message(monkeypatch):
    async def scenario():
        socket = _FakeSocket()
        calls = []

        async def connect(url: str, **kwargs):
            calls.append((url, kwargs))
            return socket

        provider = SarvamStreamingProvider(connect=connect, api_key="unit-test-key")
        await provider.connect_stt("en")
        await provider.send_audio(bytes(1024))
        url, kwargs = calls[0]
        assert urlsplit(url).path == "/speech-to-text/ws"
        assert parse_qs(urlsplit(url).query) == {
            "language-code": ["en-IN"], "model": ["saaras:v3"], "mode": ["transcribe"],
            "sample_rate": ["16000"], "input_audio_codec": ["pcm_s16le"],
            "vad_signals": ["true"], "flush_signal": ["true"],
            "high_vad_sensitivity": ["true"],
        }
        assert kwargs["additional_headers"] == {"Api-Subscription-Key": "unit-test-key"}
        assert json.loads(socket.sent[0]) == {"audio": {
            "data": base64.b64encode(bytes(1024)).decode("ascii"),
            "sample_rate": 16000, "encoding": "audio/wav",
        }}

        await provider.send_audio(bytes(1024), payload_encoding="pcm_s16le")
        assert json.loads(socket.sent[1])["audio"]["encoding"] == "pcm_s16le"

    monkeypatch.delenv("SARVAM_STT_STREAM_MESSAGE_ENCODING", raising=False)
    asyncio.run(scenario())


def test_streaming_stt_encoding_enum_and_safe_provider_error_mapping(monkeypatch):
    monkeypatch.setenv("SARVAM_STT_STREAM_MESSAGE_ENCODING", "not-an-encoding")
    with pytest.raises(ValueError, match="unsupported"):
        sarvam_stt_message_encoding()

    async def scenario():
        socket = _FakeSocket([
            json.dumps({"type": "error", "data": {
                "code": "INVALID_AUDIO_ENCODING", "message": "private provider body",
                "audio": "must-not-escape", "status": 422,
            }})
        ])

        async def connect(_url: str, **_kwargs):
            return socket

        provider = SarvamStreamingProvider(connect=connect, api_key="unit-test-key")
        await provider.connect_stt("en")
        events = [event async for event in provider.stt_events()]
        assert events == [{
            "type": "provider_error", "category": "protocol",
            "safe_code": "invalid_audio_encoding", "websocket_close_code": None,
            "handshake_status": 422, "retryable": False,
        }]
        serialized = json.dumps(events)
        assert "private provider body" not in serialized
        assert "must-not-escape" not in serialized
        assert "unit-test-key" not in serialized

    monkeypatch.setenv("SARVAM_STT_STREAM_MESSAGE_ENCODING", "audio/wav")
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


def test_provider_protocol_error_releases_reservation_and_session_lock(client, monkeypatch):
    _enable(monkeypatch)
    user = create_test_user("voice-protocol", "voice-protocol@example.com")
    _set_balance(int(user.id), "chat", 5_000_000)
    _set_balance(int(user.id), "voice", 5_000_000)

    class ProtocolFailureProvider:
        stt_connected = False
        async def connect_stt(self, _language):
            self.stt_connected = True
        async def stt_events(self):
            yield {
                "type": "provider_error", "category": "protocol",
                "safe_code": "invalid_audio_encoding", "websocket_close_code": 4400,
                "handshake_status": None, "retryable": False,
            }
        async def close(self):
            return None
        async def close_tts(self):
            return None

    monkeypatch.setattr("app.web_api.router.SarvamStreamingProvider", ProtocolFailureProvider)
    created = _session(client, "voice-protocol", "voice-protocol@example.com")
    with pytest.raises(WebSocketDisconnect) as stopped:
        with client.websocket_connect(
            f"/api/web/voice/ws?ticket={created.json()['ticket']}", headers={"origin": ORIGIN},
        ) as socket:
            assert socket.receive_json()["state"] == "connected"
            socket.send_json({
                "protocol_version": 1, "type": "session.start",
                "audio": {"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1, "frame_samples": 512},
            })
            messages = []
            while True:
                message = socket.receive_json()
                messages.append(message)
                if message.get("type") == "error":
                    assert message["code"] == "sarvam_protocol_error"
    assert stopped.value.code == 4463
    # Cleanup has compare-deleted the old lock and released the unused STT reserve.
    assert _session(client, "voice-protocol", "voice-protocol@example.com").status_code == 201


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


def test_backchannel_gate_is_local_rate_limited_and_never_completes_a_turn():
    # This pure gate has no request/provider argument and only authorizes a
    # locally bundled cue; model generation remains tied to finalized STT.
    assert _voice_backchannel_due(
        enabled=True, state=VoiceState.LISTENING, utterance_started_at=10.0,
        last_backchannel_at=0.0, now=18.0,
        classification=TranscriptClassification.UNFINISHED,
    )
    assert not _voice_backchannel_due(
        enabled=True, state=VoiceState.LISTENING, utterance_started_at=10.0,
        last_backchannel_at=17.0, now=18.0,
        classification=TranscriptClassification.UNFINISHED,
    )
    assert not _voice_backchannel_due(
        enabled=True, state=VoiceState.LISTENING, utterance_started_at=10.0,
        last_backchannel_at=0.0, now=18.0,
        classification=TranscriptClassification.COMPLETE,
    )
