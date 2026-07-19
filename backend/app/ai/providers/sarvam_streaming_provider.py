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

from .sarvam_provider import (
    normalize_sarvam_tts_language_code,
    normalize_sarvam_tts_model,
    resolve_sarvam_tts_voice,
)


SARVAM_STREAMING_STT_URL = "wss://api.sarvam.ai/speech-to-text/ws"
SARVAM_STREAMING_TTS_URL = "wss://api.sarvam.ai/text-to-speech/ws"


class SarvamStreamingError(RuntimeError):
    pass


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
            return await self._connect(
                url, additional_headers={"Api-Subscription-Key": self._api_key}, **kwargs
            )
        except TypeError:
            return await self._connect(
                url, extra_headers={"Api-Subscription-Key": self._api_key}, **kwargs
            )

    async def connect_stt(self, language: str) -> None:
        language_code = normalize_sarvam_tts_language_code(language)
        query = urlencode({
            "language-code": language_code,
            "model": os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
            "mode": "transcribe",
            "sample_rate": "16000",
            "input_audio_codec": "pcm_s16le",
            "vad_signals": "true",
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
        async for raw in self._stt:
            payload = json.loads(raw)
            event_type = str(payload.get("type") or "")
            data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
            transcript = str(data.get("transcript") or "")
            if event_type in {"speech_start", "speech_end"}:
                yield {"type": event_type}
            elif transcript:
                final = event_type in {"transcript", "data"} and not bool(data.get("partial"))
                yield {
                    "type": "final" if final else "partial",
                    "transcript": transcript,
                    "audio_milliseconds": max(0, int(float((data.get("metrics") or {}).get("audio_duration") or 0) * 1000)),
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
        async for raw in self._tts:
            payload = json.loads(raw)
            if payload.get("type") == "audio":
                data = payload.get("data") or {}
                encoded = data.get("audio")
                if encoded:
                    yield base64.b64decode(encoded, validate=True)
            elif payload.get("type") in {"event", "completion"}:
                return

    async def close(self) -> None:
        sockets = [socket for socket in (self._stt, self._tts) if socket is not None]
        self._stt = self._tts = None
        await asyncio.gather(*(socket.close() for socket in sockets), return_exceptions=True)

    async def close_tts(self) -> None:
        socket, self._tts = self._tts, None
        if socket is not None:
            await asyncio.gather(socket.close(), return_exceptions=True)
