"""Explicitly opt-in, billable Sarvam realtime voice interoperability probe.

This module is never invoked by application startup, CI, deployment, or the
default test suite. It prints only safe protocol outcomes and byte/event counts.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from app.ai.providers.sarvam_streaming_provider import SarvamStreamingProvider


def _allowed() -> bool:
    return os.getenv("ALLOW_LIVE_SARVAM_VOICE_PROBE", "").strip().lower() == "true"


async def _probe() -> dict[str, object]:
    provider = SarvamStreamingProvider()
    stt_events = 0
    tts_chunks = 0
    tts_bytes = 0
    try:
        await provider.connect_stt("en")
        # 100 ms of local silence verifies the documented PCM JSON envelope.
        # It is intentionally bounded; transcripts are neither printed nor stored.
        await provider.send_audio(bytes(3_200))
        await provider.flush_stt()
        try:
            iterator = provider.stt_events()
            event = await asyncio.wait_for(anext(iterator), timeout=8)
            stt_events = 1 if event.get("type") else 0
        except (asyncio.TimeoutError, StopAsyncIteration):
            stt_events = 0

        await provider.connect_tts("en")
        await provider.ping_tts()
        await provider.send_tts_text("Swico voice readiness probe.")
        await provider.flush_tts()
        async for chunk in provider.tts_audio():
            tts_chunks += 1
            tts_bytes += len(chunk)
        return {
            "ok": bool(tts_chunks and tts_bytes),
            "stt_connected": True,
            "stt_safe_event_count": stt_events,
            "tts_chunk_count": tts_chunks,
            "tts_audio_bytes": tts_bytes,
            "stt_model": os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
            "tts_model": os.getenv("SARVAM_TTS_MODEL", "bulbul:v2"),
        }
    finally:
        await provider.close()


def main() -> int:
    if not _allowed():
        print("Refusing live probe: set ALLOW_LIVE_SARVAM_VOICE_PROBE=true explicitly.", file=sys.stderr)
        return 2
    if not os.getenv("SARVAM_API_KEY", "").strip():
        print("Refusing live probe: SARVAM_API_KEY is not configured.", file=sys.stderr)
        return 2
    try:
        result = asyncio.run(_probe())
    except Exception as exc:
        # Class name is safe; provider bodies and exception strings are not emitted.
        print(json.dumps({"ok": False, "error_type": type(exc).__name__}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
