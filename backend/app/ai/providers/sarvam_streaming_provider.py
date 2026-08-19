"""Async, mockable Sarvam streaming speech adapter.

Provider credentials and schemas remain server-side. This module intentionally
does not log audio, transcripts, or synthesized text.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from collections.abc import AsyncIterator, Callable
from typing import Any
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from .sarvam_provider import (
    normalize_audio_language,
    normalize_sarvam_tts_language_code,
    normalize_sarvam_tts_model,
    resolve_sarvam_tts_voice,
)


SARVAM_STREAMING_STT_URL = "wss://api.sarvam.ai/speech-to-text/ws"
SARVAM_STREAMING_TTS_URL = "wss://api.sarvam.ai/text-to-speech/ws"
SARVAM_STT_SAMPLE_RATE = 16_000
SARVAM_STT_INPUT_AUDIO_CODEC = "pcm_s16le"
SARVAM_STT_MESSAGE_ENCODINGS = frozenset({"audio/wav", "pcm_s16le"})
SARVAM_TTS_OPERATOR_CODECS = frozenset({"mp3", "linear16"})
SARVAM_TTS_SAMPLE_RATES = frozenset({8_000, 16_000, 22_050, 24_000})
# sarvamai 0.1.28's generated ConfigureConnectionDataOutputAudioCodec schema
# and socket serializer send `linear16` unchanged. Keep this normalization at
# the provider edge so an SDK/API contract change remains one-line and tested.
SARVAM_TTS_WIRE_CODECS = {"mp3": "mp3", "linear16": "linear16"}


def sarvam_stt_message_encoding(value: str | None = None) -> str:
    configured = str(
        value if value is not None else os.getenv("SARVAM_STT_STREAM_MESSAGE_ENCODING", "audio/wav")
    ).strip().lower()
    if configured not in SARVAM_STT_MESSAGE_ENCODINGS:
        raise ValueError("SARVAM_STT_STREAM_MESSAGE_ENCODING is unsupported.")
    return configured


def sarvam_tts_output_codec(value: str | None = None) -> str:
    configured = str(
        value if value is not None else os.getenv("SARVAM_TTS_STREAM_OUTPUT_CODEC", "mp3")
    ).strip().lower()
    if configured not in SARVAM_TTS_OPERATOR_CODECS:
        raise ValueError("SARVAM_TTS_STREAM_OUTPUT_CODEC is unsupported.")
    return configured


def sarvam_tts_sample_rate(value: int | str | None = None) -> int:
    raw = value if value is not None else os.getenv("SARVAM_TTS_STREAM_SAMPLE_RATE", "24000")
    try:
        configured = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("SARVAM_TTS_STREAM_SAMPLE_RATE is unsupported.") from exc
    if configured not in SARVAM_TTS_SAMPLE_RATES:
        raise ValueError("SARVAM_TTS_STREAM_SAMPLE_RATE is unsupported.")
    return configured


class SarvamStreamingError(RuntimeError):
    """Sanitized provider failure; raw provider payloads never leave the adapter."""

    def __init__(
        self, message: str, *, category: str = "temporary",
        safe_code: str = "unknown_provider_error",
        websocket_close_code: int | None = None,
        handshake_status: int | None = None,
        retryable: bool | None = None,
        close_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.category = category
        self.safe_code = safe_code
        self.websocket_close_code = websocket_close_code if websocket_close_code is not None else close_code
        self.handshake_status = handshake_status
        self.retryable = category == "temporary" if retryable is None else bool(retryable)

    @property
    def close_code(self) -> int | None:
        """Backward-compatible alias used by older call sites."""
        return self.websocket_close_code


def _provider_category(code: int | None, reason: str = "") -> str:
    # Kept local to avoid coupling the provider layer to the web router.
    lowered = str(reason or "").lower()
    if code in {4001, 4003, 4401, 4403} or any(x in lowered for x in ("auth", "api key", "unauthor", "forbidden")):
        return "authentication"
    if code in {4008, 4029, 429, 4429} or any(x in lowered for x in ("quota", "rate limit", "too many")):
        return "quota"
    if code in {1002, 1003, 1007, 1008, 400, 404, 405, 415, 422, 426, 4400} or any(
        x in lowered for x in ("protocol", "encoding", "codec", "sample rate", "invalid message")
    ):
        return "protocol"
    return "temporary"


def _bounded_scalar(value: Any) -> str:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return ""
    return str(value).strip().lower()[:80]


def _safe_provider_code(value: str, *, category: str, close_code: int | None = None) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")[:80]
    if "sample" in normalized and "rate" in normalized:
        return "invalid_sample_rate"
    if any(marker in normalized for marker in ("encoding", "codec", "audio_format")):
        return "invalid_audio_encoding"
    if "audio" in normalized and any(marker in normalized for marker in ("frame", "chunk", "data")):
        return "invalid_audio_frame"
    if any(marker in normalized for marker in ("auth", "api_key", "unauthor", "forbidden", "credential")):
        return "authentication_failed"
    if any(marker in normalized for marker in ("rate_limit", "too_many")):
        return "rate_limited"
    if any(marker in normalized for marker in ("quota", "credit", "limit_exceeded")):
        return "quota_exhausted"
    if any(marker in normalized for marker in ("internal", "server_error", "unavailable")):
        return "provider_internal"
    if close_code == 1006:
        return "abnormal_close"
    if category == "protocol":
        return "invalid_message"
    if category == "authentication":
        return "authentication_failed"
    if category == "quota":
        return "rate_limited" if close_code in {429, 4429} else "quota_exhausted"
    if close_code in {1006, 1011}:
        return "abnormal_close" if close_code == 1006 else "provider_internal"
    return "unknown_provider_error"


def _error_fields(payload: dict[str, Any]) -> tuple[str, int | None]:
    """Read bounded scalar code/status fields only; never retain a provider body."""
    data = (
        payload.get("data") if isinstance(payload.get("data"), dict)
        else payload.get("error") if isinstance(payload.get("error"), dict)
        else payload
    )
    values = [
        _bounded_scalar(data.get(name))
        for name in ("code", "error_code", "status", "status_code", "type")
    ]
    scalar = " ".join(value for value in values if value)
    status: int | None = None
    for name in ("status", "status_code"):
        try:
            candidate = int(data.get(name))
        except (TypeError, ValueError):
            continue
        if 100 <= candidate <= 599:
            status = candidate
            break
    return scalar, status


def _handshake_status(exc: BaseException) -> int | None:
    """Read only the HTTP status from a failed handshake, never its body."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(exc, "status_code", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def _handshake_category(status: int | None) -> str:
    if status in {401, 403}:
        return "authentication"
    if status == 429:
        return "quota"
    if status in {400, 404, 405, 406, 409, 415, 422, 426}:
        return "protocol"
    return "temporary"


class SarvamStreamingProvider:
    """Small protocol adapter whose connector is injectable in tests."""

    def __init__(self, *, connect: Callable[..., Any] = websockets.connect,
                 api_key: str | None = None) -> None:
        self._connect = connect
        self._api_key = api_key if api_key is not None else os.getenv("SARVAM_API_KEY", "").strip()
        self._stt: Any = None
        self._tts: Any = None
        self._tts_ping_task: asyncio.Task[Any] | None = None
        self._tts_completion_received = False

    @property
    def stt_connected(self) -> bool:
        return self._stt is not None

    @property
    def tts_connected(self) -> bool:
        return self._tts is not None

    @property
    def tts_completion_received(self) -> bool:
        return self._tts_completion_received

    async def _open(self, url: str):
        if not self._api_key:
            raise SarvamStreamingError(
                "Sarvam streaming is not configured.", category="authentication",
                safe_code="authentication_failed", retryable=False,
            )
        kwargs = {
            "ping_interval": 20,
            "ping_timeout": 20,
            "open_timeout": 10,
            "close_timeout": 5,
            "max_size": 2 * 1024 * 1024,
            "max_queue": 16,
        }
        # websockets 15 uses additional_headers; 10.x uses extra_headers.
        try:
            try:
                return await self._connect(
                    url, additional_headers={"Api-Subscription-Key": self._api_key}, **kwargs
                )
            except TypeError:
                return await self._connect(
                    url, extra_headers={"Api-Subscription-Key": self._api_key}, **kwargs
                )
        except InvalidStatus as exc:
            status = _handshake_status(exc)
            category = _handshake_category(status)
            raise SarvamStreamingError(
                "Sarvam streaming connection was rejected.",
                category=category, safe_code=_safe_provider_code("", category=category, close_code=status),
                handshake_status=status, retryable=status in {429, 500, 502, 503, 504},
            ) from exc
        except ConnectionClosed as exc:
            category = _provider_category(exc.code, exc.reason)
            raise SarvamStreamingError(
                "Sarvam streaming connection was rejected.",
                category=category,
                safe_code=_safe_provider_code(_bounded_scalar(exc.reason), category=category, close_code=exc.code),
                websocket_close_code=exc.code,
            ) from exc
        except InvalidHandshake as exc:
            status = _handshake_status(exc)
            category = _handshake_category(status)
            raise SarvamStreamingError(
                "Sarvam streaming handshake failed.",
                category=category, safe_code=_safe_provider_code("", category=category, close_code=status),
                handshake_status=status, retryable=status not in {400, 401, 403, 404, 405, 415, 422, 426},
            ) from exc
        except (OSError, asyncio.TimeoutError) as exc:
            raise SarvamStreamingError(
                "Sarvam streaming is temporarily unavailable.",
                safe_code="abnormal_close", retryable=True,
            ) from exc

    async def connect_stt(self, language: str | None = None, *, mode: str | None = None) -> None:
        language_code = normalize_audio_language(language) or "unknown"
        stt_mode = str(mode or os.getenv("SARVAM_STT_MODE", "transcribe")).strip().lower() or "transcribe"
        if stt_mode not in {"transcribe", "translit"}:
            stt_mode = "transcribe"
        query = urlencode({
            "language-code": language_code,
            "model": os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
            "mode": stt_mode,
            "sample_rate": str(SARVAM_STT_SAMPLE_RATE),
            "input_audio_codec": SARVAM_STT_INPUT_AUDIO_CODEC,
            "vad_signals": "true",
            "flush_signal": "true",
            "high_vad_sensitivity": "true",
        })
        self._stt = await self._open(f"{SARVAM_STREAMING_STT_URL}?{query}")

    async def send_audio(self, pcm_s16le: bytes, *, payload_encoding: str | None = None) -> None:
        if self._stt is None:
            raise SarvamStreamingError("STT stream is not connected.")
        encoding = sarvam_stt_message_encoding(payload_encoding)
        await self._stt.send(json.dumps({
            "audio": {
                "data": base64.b64encode(pcm_s16le).decode("ascii"),
                "sample_rate": SARVAM_STT_SAMPLE_RATE,
                "encoding": encoding,
            }
        }, separators=(",", ":")))

    async def stt_events(self) -> AsyncIterator[dict[str, Any]]:
        if self._stt is None:
            raise SarvamStreamingError("STT stream is not connected.")
        try:
            async for raw in self._stt:
                try:
                    payload = json.loads(raw)
                except (json.JSONDecodeError, TypeError) as exc:
                    raise SarvamStreamingError(
                        "Sarvam returned an incompatible STT message.", category="protocol"
                    ) from exc
                if not isinstance(payload, dict):
                    raise SarvamStreamingError("Sarvam returned an incompatible STT message.", category="protocol")
                event_type = str(payload.get("type") or "").strip().lower()
                data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
                signal = str(data.get("signal_type") or data.get("event_type") or "").strip().upper()
                if event_type in {"events", "event"} and signal in {"START_SPEECH", "SPEECH_START"}:
                    yield {"type": "speech_start"}
                    continue
                if event_type in {"events", "event"} and signal in {"END_SPEECH", "SPEECH_END"}:
                    yield {"type": "speech_end"}
                    continue
                if event_type in {"speech_start", "start_speech"}:
                    yield {"type": "speech_start"}
                    continue
                if event_type in {"speech_end", "end_speech"}:
                    yield {"type": "speech_end"}
                    continue
                if event_type in {"error", "errors"} or payload.get("error"):
                    scalar, status = _error_fields(payload)
                    category = _handshake_category(status) if status else _provider_category(None, scalar)
                    yield {
                        "type": "provider_error",
                        "category": category,
                        "safe_code": _safe_provider_code(scalar, category=category),
                        "websocket_close_code": None,
                        "handshake_status": status,
                        "retryable": category == "temporary" or status == 429,
                    }
                    continue
                transcript = str(data.get("transcript") or "").strip()
                if transcript:
                    partial = bool(data.get("partial")) or event_type in {
                        "partial", "partial_transcript", "interim", "interim_transcript",
                    }
                    metrics = data.get("metrics") if isinstance(data.get("metrics"), dict) else {}
                    yield {
                        "type": "partial" if partial else "final",
                        "transcript": transcript,
                        "audio_milliseconds": max(
                            0, int(float(metrics.get("audio_duration") or data.get("duration") or 0) * 1000)
                        ),
                    }
                    continue
                if event_type in {"warning", "warnings"}:
                    yield {"type": "provider_warning"}
        except ConnectionClosed as exc:
            category = _provider_category(exc.code, exc.reason)
            yield {
                "type": "provider_error",
                "category": category,
                "safe_code": _safe_provider_code(
                    _bounded_scalar(exc.reason), category=category, close_code=exc.code
                ),
                "websocket_close_code": exc.code,
                "handshake_status": None,
                "retryable": category == "temporary" or exc.code in {1013, 4429},
            }

    async def connect_tts(
        self, language: str, *, output_codec: str | None = None,
        sample_rate: int | str | None = None,
    ) -> None:
        language_code = normalize_sarvam_tts_language_code(language)
        model = normalize_sarvam_tts_model(os.getenv("SARVAM_TTS_MODEL"), premium=False)
        codec = sarvam_tts_output_codec(output_codec)
        rate = sarvam_tts_sample_rate(sample_rate)
        self._tts_completion_received = False
        self._tts = await self._open(
            f"{SARVAM_STREAMING_TTS_URL}?{urlencode({'model': model, 'send_completion_event': 'true'})}"
        )
        voice = resolve_sarvam_tts_voice(language_code)
        await self._tts.send(json.dumps({
            "type": "config",
            "data": {
                "target_language_code": language_code,
                "speaker": voice["speaker"],
                "pace": voice.get("pace", 1.0),
                "min_buffer_size": 40,
                "max_chunk_length": 240,
                "output_audio_codec": SARVAM_TTS_WIRE_CODECS[codec],
                "speech_sample_rate": rate,
            },
        }, separators=(",", ":")))
        self._tts_ping_task = asyncio.create_task(
            self._tts_keepalive(), name="sarvam-tts-application-ping"
        )

    async def ping_tts(self) -> None:
        """Send Sarvam's JSON application ping, not a WebSocket control ping."""
        if self._tts is not None:
            await self._tts.send('{"type":"ping"}')

    async def _tts_keepalive(self) -> None:
        try:
            while self._tts is not None:
                await asyncio.sleep(25)
                await self.ping_tts()
        except (asyncio.CancelledError, ConnectionClosed):
            return

    async def send_tts_text(self, text: str) -> None:
        if self._tts is None:
            raise SarvamStreamingError("TTS stream is not connected.")
        cleaned = " ".join(text.split()).strip()
        if cleaned:
            await self._tts.send(json.dumps(
                {"type": "text", "data": {"text": cleaned}}, separators=(",", ":")
            ))

    async def flush_tts(self) -> None:
        if self._tts is not None:
            await self._tts.send('{"type":"flush"}')

    async def flush_stt(self) -> None:
        if self._stt is not None:
            await self._stt.send('{"type":"flush"}')

    async def tts_audio(self) -> AsyncIterator[bytes]:
        if self._tts is None:
            raise SarvamStreamingError("TTS stream is not connected.")
        try:
            async for raw in self._tts:
                try:
                    payload = json.loads(raw)
                except (json.JSONDecodeError, TypeError) as exc:
                    raise SarvamStreamingError(
                        "Sarvam returned an incompatible TTS message.", category="protocol"
                    ) from exc
                if payload.get("type") == "audio":
                    data = payload.get("data") or {}
                    encoded = data.get("audio")
                    if encoded:
                        try:
                            yield base64.b64decode(encoded, validate=True)
                        except (ValueError, TypeError) as exc:
                            raise SarvamStreamingError(
                                "Sarvam returned invalid TTS audio.", category="protocol"
                            ) from exc
                elif payload.get("type") in {"event", "events", "completion"}:
                    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
                    if payload.get("type") == "completion" or str(data.get("event_type") or "").lower() in {
                        "final", "complete", "completion",
                    }:
                        self._tts_completion_received = True
                        return
                elif payload.get("type") == "error" or payload.get("error"):
                    scalar, status = _error_fields(payload)
                    category = _handshake_category(status) if status else _provider_category(None, scalar)
                    raise SarvamStreamingError(
                        "Sarvam TTS rejected the stream.",
                        category=category,
                        safe_code=_safe_provider_code(scalar, category=category),
                        handshake_status=status,
                        retryable=category == "temporary" or status == 429,
                    )
            if not self._tts_completion_received:
                raise SarvamStreamingError(
                    "Sarvam TTS ended without completion.", category="protocol",
                    safe_code="invalid_message", retryable=False,
                )
        except ConnectionClosed as exc:
            category = _provider_category(exc.code, exc.reason)
            raise SarvamStreamingError(
                "Sarvam TTS connection closed unexpectedly.",
                category=category,
                safe_code=_safe_provider_code(
                    _bounded_scalar(exc.reason), category=category, close_code=exc.code
                ),
                websocket_close_code=exc.code,
            ) from exc

    async def close(self) -> None:
        ping_task, self._tts_ping_task = self._tts_ping_task, None
        if ping_task is not None:
            ping_task.cancel()
        sockets = [socket for socket in (self._stt, self._tts) if socket is not None]
        self._stt = self._tts = None
        await asyncio.gather(
            *([ping_task] if ping_task is not None else []),
            *(socket.close() for socket in sockets), return_exceptions=True,
        )

    async def close_tts(self) -> None:
        ping_task, self._tts_ping_task = self._tts_ping_task, None
        if ping_task is not None:
            ping_task.cancel()
        socket, self._tts = self._tts, None
        await asyncio.gather(
            *([ping_task] if ping_task is not None else []),
            *([socket.close()] if socket is not None else []), return_exceptions=True,
        )
