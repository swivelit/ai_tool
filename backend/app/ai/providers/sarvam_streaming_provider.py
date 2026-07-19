"""Async, mockable Sarvam streaming speech adapter.

Provider credentials and schemas remain server-side. This module intentionally
does not log audio, transcripts, or synthesized text.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from collections.abc import AsyncIterator, Callable
from typing import Any
from urllib.parse import urlencode

import websockets
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from .sarvam_provider import (
    normalize_sarvam_tts_language_code,
    normalize_sarvam_tts_model,
    resolve_sarvam_tts_voice,
)


SARVAM_STREAMING_STT_URL = "wss://api.sarvam.ai/speech-to-text/ws"
SARVAM_STREAMING_TTS_URL = "wss://api.sarvam.ai/text-to-speech/ws"


class SarvamStreamingError(RuntimeError):
    """Sanitized provider failure; raw provider payloads never leave the adapter."""

    def __init__(self, message: str, *, category: str = "temporary", close_code: int | None = None) -> None:
        super().__init__(message)
        self.category = category
        self.close_code = close_code


def _provider_category(code: int | None, reason: str = "") -> str:
    # Kept local to avoid coupling the provider layer to the web router.
    lowered = str(reason or "").lower()
    if code in {4001, 4003, 4401, 4403} or any(x in lowered for x in ("auth", "api key", "unauthor", "forbidden")):
        return "authentication"
    if code in {4008, 4029, 429, 4429} or any(x in lowered for x in ("quota", "rate limit", "too many")):
        return "quota"
    if code in {1002, 1003, 1007, 1008} or "protocol" in lowered:
        return "protocol"
    return "temporary"


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

    @property
    def stt_connected(self) -> bool:
        return self._stt is not None

    @property
    def tts_connected(self) -> bool:
        return self._tts is not None

    async def _open(self, url: str):
        if not self._api_key:
            raise SarvamStreamingError("Sarvam streaming is not configured.")
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
            raise SarvamStreamingError(
                "Sarvam streaming connection was rejected.",
                category=_handshake_category(status), close_code=status,
            ) from exc
        except ConnectionClosed as exc:
            raise SarvamStreamingError(
                "Sarvam streaming connection was rejected.",
                category=_provider_category(exc.code, exc.reason), close_code=exc.code,
            ) from exc
        except InvalidHandshake as exc:
            status = _handshake_status(exc)
            raise SarvamStreamingError(
                "Sarvam streaming handshake failed.",
                category=_handshake_category(status), close_code=status,
            ) from exc
        except (OSError, asyncio.TimeoutError) as exc:
            raise SarvamStreamingError("Sarvam streaming is temporarily unavailable.") from exc

    async def connect_stt(self, language: str) -> None:
        language_code = normalize_sarvam_tts_language_code(language)
        query = urlencode({
            "language-code": language_code,
            "model": os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
            "mode": "transcribe",
            "sample_rate": "16000",
            "input_audio_codec": "pcm_s16le",
            "vad_signals": "true",
            "flush_signal": "true",
            "high_vad_sensitivity": "true",
        })
        self._stt = await self._open(f"{SARVAM_STREAMING_STT_URL}?{query}")

    async def send_audio(self, pcm_s16le: bytes) -> None:
        if self._stt is None:
            raise SarvamStreamingError("STT stream is not connected.")
        await self._stt.send(json.dumps({
            "audio": {
                "data": base64.b64encode(pcm_s16le).decode("ascii"),
                "sample_rate": 16000,
                "encoding": "pcm_s16le",
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
                    category = _provider_category(None, str(data.get("code") or data.get("message") or ""))
                    yield {"type": "provider_error", "category": category, "close_code": None}
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
            yield {
                "type": "provider_error",
                "category": _provider_category(exc.code, exc.reason),
                "close_code": exc.code,
            }

    async def connect_tts(self, language: str) -> None:
        language_code = normalize_sarvam_tts_language_code(language)
        model = normalize_sarvam_tts_model(os.getenv("SARVAM_TTS_MODEL"), premium=False)
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
                "output_audio_codec": "mp3",
            },
        }, separators=(",", ":")))

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
                        return
                elif payload.get("type") == "error" or payload.get("error"):
                    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
                    raise SarvamStreamingError(
                        "Sarvam TTS rejected the stream.",
                        category=_provider_category(None, str(data.get("code") or data.get("message") or "")),
                    )
        except ConnectionClosed as exc:
            raise SarvamStreamingError(
                "Sarvam TTS connection closed unexpectedly.",
                category=_provider_category(exc.code, exc.reason), close_code=exc.code,
            ) from exc

    async def close(self) -> None:
        sockets = [socket for socket in (self._stt, self._tts) if socket is not None]
        self._stt = self._tts = None
        await asyncio.gather(*(socket.close() for socket in sockets), return_exceptions=True)

    async def close_tts(self) -> None:
        socket, self._tts = self._tts, None
        if socket is not None:
            await asyncio.gather(socket.close(), return_exceptions=True)
