"""Explicit opt-in, billable Sarvam streaming voice protocol probe.

Never invoked by startup, CI, deployment, or the default test suite. Output is
limited to protocol metadata and booleans; transcripts and audio are discarded.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
from pathlib import Path
import struct
import sys
import time
import wave
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.ai.providers.sarvam_streaming_provider import (
    SARVAM_STT_INPUT_AUDIO_CODEC,
    SARVAM_STT_SAMPLE_RATE,
    SarvamStreamingError,
    SarvamStreamingProvider,
    sarvam_stt_message_encoding,
)

FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
MAX_AUDIO_SECONDS = 5


@dataclass(frozen=True)
class ProbeOptions:
    mode: str
    language: str
    payload_encoding: str
    audio_file: Path | None = None


def _allowed() -> bool:
    return os.getenv("ALLOW_LIVE_SARVAM_VOICE_PROBE", "").strip().lower() == "true"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Opt-in Sarvam voice protocol probe")
    parser.add_argument("--mode", required=True, choices=("stt", "tts", "both"))
    parser.add_argument("--language", required=True, choices=("en", "ta"))
    parser.add_argument("--payload-encoding", choices=("audio/wav", "pcm_s16le"))
    parser.add_argument("--audio-file", type=Path)
    return parser


def _synthetic_pcm() -> bytes:
    """One bounded second of non-customer, speech-like multi-tone PCM."""
    output = bytearray()
    for index in range(SARVAM_STT_SAMPLE_RATE):
        envelope = min(1.0, index / 800, (SARVAM_STT_SAMPLE_RATE - index) / 800)
        sample = envelope * (
            0.20 * math.sin(2 * math.pi * 180 * index / SARVAM_STT_SAMPLE_RATE)
            + 0.08 * math.sin(2 * math.pi * 360 * index / SARVAM_STT_SAMPLE_RATE)
        )
        output.extend(struct.pack("<h", max(-32768, min(32767, round(sample * 32767)))))
    return bytes(output)


def _operator_pcm(path: Path) -> bytes:
    resolved = path.expanduser().resolve(strict=True)
    if not resolved.is_file() or resolved.suffix.lower() not in {".wav", ".wave"}:
        raise ValueError("audio_file_must_be_local_wav")
    with wave.open(str(resolved), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000:
            raise ValueError("audio_file_must_be_mono_pcm16_16000hz")
        frames = source.getnframes()
        if frames <= 0 or frames > MAX_AUDIO_SECONDS * SARVAM_STT_SAMPLE_RATE:
            raise ValueError("audio_file_duration_out_of_range")
        return source.readframes(frames)


def _frames(pcm: bytes) -> list[bytes]:
    output = []
    for offset in range(0, len(pcm), FRAME_BYTES):
        frame = pcm[offset:offset + FRAME_BYTES]
        if len(frame) < FRAME_BYTES:
            frame += bytes(FRAME_BYTES - len(frame))
        if frame:
            output.append(frame)
    return output


async def _probe_stt(provider: SarvamStreamingProvider, options: ProbeOptions) -> dict[str, Any]:
    started = time.monotonic()
    result: dict[str, Any] = {
        "ok": False, "handshake_succeeded": False,
        "payload_encoding": options.payload_encoding,
        "input_audio_codec": SARVAM_STT_INPUT_AUDIO_CODEC,
        "sample_rate": SARVAM_STT_SAMPLE_RATE, "frame_samples": FRAME_SAMPLES,
        "frames_sent": 0, "flush_sent": False, "speech_event_received": False,
        "transcript_event_received": False, "provider_safe_code": None,
        "provider_close_code": None, "classification": "not_started",
    }
    try:
        await provider.connect_stt(options.language)
        result["handshake_succeeded"] = True
        pcm = _operator_pcm(options.audio_file) if options.audio_file else _synthetic_pcm()
        for frame in _frames(pcm):
            await provider.send_audio(frame, payload_encoding=options.payload_encoding)
            result["frames_sent"] += 1
        await provider.flush_stt()
        result["flush_sent"] = True
        iterator = provider.stt_events()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                event = await asyncio.wait_for(anext(iterator), timeout=max(0.05, deadline - time.monotonic()))
            except (asyncio.TimeoutError, StopAsyncIteration):
                break
            event_type = str(event.get("type") or "")
            if event_type == "provider_error":
                result["provider_safe_code"] = event.get("safe_code") or "unknown_provider_error"
                result["provider_close_code"] = event.get("websocket_close_code")
                result["classification"] = "provider_error"
                return result
            if event_type in {"speech_start", "speech_end"}:
                result["speech_event_received"] = True
            elif event_type in {"partial", "final"}:
                result["transcript_event_received"] = True
            if result["speech_event_received"] or result["transcript_event_received"]:
                break
        accepted = bool(result["speech_event_received"] or result["transcript_event_received"])
        result["classification"] = "protocol_accepted" if accepted else "inconclusive_no_speech"
        result["ok"] = accepted
        return result
    except SarvamStreamingError as exc:
        result["provider_safe_code"] = exc.safe_code
        result["provider_close_code"] = exc.websocket_close_code
        result["classification"] = "handshake_failed" if not result["handshake_succeeded"] else "provider_error"
        return result
    finally:
        result["elapsed_ms"] = int((time.monotonic() - started) * 1000)


async def _probe_tts(provider: SarvamStreamingProvider, options: ProbeOptions) -> dict[str, Any]:
    started = time.monotonic()
    result: dict[str, Any] = {
        "ok": False, "config_sent": False, "text_sent": False, "flush_sent": False,
        "audio_chunk_received": False, "completion_event_received": False,
        "provider_safe_code": None, "provider_close_code": None,
    }
    try:
        await provider.connect_tts(options.language)
        result["config_sent"] = True
        sentence = "This is a fixed Swico provider readiness test."
        await provider.send_tts_text(sentence)
        result["text_sent"] = True
        await provider.flush_tts()
        result["flush_sent"] = True
        async for chunk in provider.tts_audio():
            if chunk:
                result["audio_chunk_received"] = True
        result["completion_event_received"] = True
        result["ok"] = bool(result["audio_chunk_received"] and result["completion_event_received"])
        return result
    except SarvamStreamingError as exc:
        result["provider_safe_code"] = exc.safe_code
        result["provider_close_code"] = exc.websocket_close_code
        return result
    finally:
        result["elapsed_ms"] = int((time.monotonic() - started) * 1000)


async def run_probe(
    options: ProbeOptions,
    provider_factory: Callable[[], SarvamStreamingProvider] = SarvamStreamingProvider,
) -> dict[str, Any]:
    provider = provider_factory()
    output: dict[str, Any] = {"mode": options.mode, "language": options.language}
    try:
        if options.mode in {"stt", "both"}:
            output["stt"] = await _probe_stt(provider, options)
        if options.mode in {"tts", "both"}:
            output["tts"] = await _probe_tts(provider, options)
        requested = [output[name] for name in ("stt", "tts") if name in output]
        output["ok"] = bool(requested and all(bool(item.get("ok")) for item in requested))
        return output
    finally:
        await provider.close()


def main(argv: list[str] | None = None) -> int:
    try:
        parsed = _parser().parse_args(argv)
        encoding = sarvam_stt_message_encoding(parsed.payload_encoding)
    except ValueError as exc:
        print(json.dumps({"ok": False, "safe_code": str(exc)}, sort_keys=True))
        return 2
    if not _allowed():
        print("Refusing live probe: set ALLOW_LIVE_SARVAM_VOICE_PROBE=true explicitly.", file=sys.stderr)
        return 2
    if not os.getenv("SARVAM_API_KEY", "").strip():
        print("Refusing live probe: SARVAM_API_KEY is not configured.", file=sys.stderr)
        return 2
    options = ProbeOptions(parsed.mode, parsed.language, encoding, parsed.audio_file)
    try:
        result = asyncio.run(run_probe(options))
    except ValueError as exc:
        print(json.dumps({"ok": False, "safe_code": str(exc)[:80]}, sort_keys=True))
        return 2
    except (OSError, wave.Error):
        print(json.dumps({"ok": False, "safe_code": "audio_file_unavailable"}, sort_keys=True))
        return 2
    except Exception as exc:
        print(json.dumps({"ok": False, "error_type": type(exc).__name__}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
