from __future__ import annotations

import asyncio

from scripts import voice_provider_probe


def test_live_voice_probe_refuses_to_run_without_explicit_opt_in(monkeypatch, capsys):
    monkeypatch.delenv("ALLOW_LIVE_SARVAM_VOICE_PROBE", raising=False)
    monkeypatch.setenv("SARVAM_API_KEY", "must-not-be-used")
    called = False

    def forbidden_run(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("live probe must not run")

    monkeypatch.setattr(voice_provider_probe.asyncio, "run", forbidden_run)
    assert voice_provider_probe.main(["--mode", "both", "--language", "en"]) == 2
    assert called is False
    assert "ALLOW_LIVE_SARVAM_VOICE_PROBE=true" in capsys.readouterr().err


def test_live_voice_probe_requires_provider_key_after_opt_in(monkeypatch, capsys):
    monkeypatch.setenv("ALLOW_LIVE_SARVAM_VOICE_PROBE", "true")
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    assert voice_provider_probe.main(["--mode", "stt", "--language", "en"]) == 2
    assert "SARVAM_API_KEY" in capsys.readouterr().err


class FakeProvider:
    def __init__(self, stt_events=None, tts_chunks=None):
        self.events = list(stt_events or [])
        self.chunks = list(tts_chunks or [])
        self.audio = []
        self.stt_flushes = 0
        self.tts_flushes = 0
        self.closed = False

    async def connect_stt(self, language):
        self.stt_language = language

    async def send_audio(self, frame, *, payload_encoding=None):
        self.audio.append((frame, payload_encoding))

    async def flush_stt(self):
        self.stt_flushes += 1

    async def stt_events(self):
        for event in self.events:
            yield event

    async def connect_tts(self, language):
        self.tts_language = language

    async def send_tts_text(self, text):
        self.text = text

    async def flush_tts(self):
        self.tts_flushes += 1

    async def tts_audio(self):
        for chunk in self.chunks:
            yield chunk

    async def close(self):
        self.closed = True


def options(mode="stt", encoding="audio/wav"):
    return voice_provider_probe.ProbeOptions(mode, "en", encoding)


def test_stt_probe_reports_protocol_acceptance_and_exact_frames():
    provider = FakeProvider(stt_events=[{"type": "speech_start"}])
    result = asyncio.run(voice_provider_probe.run_probe(options(), lambda: provider))
    assert result["ok"] is True
    assert result["stt"] == {
        "ok": True, "handshake_succeeded": True, "payload_encoding": "audio/wav",
        "input_audio_codec": "pcm_s16le", "sample_rate": 16000, "frame_samples": 512,
        "frames_sent": 32, "flush_sent": True, "speech_event_received": True,
        "transcript_event_received": False, "provider_safe_code": None,
        "provider_close_code": None, "classification": "protocol_accepted",
        "elapsed_ms": result["stt"]["elapsed_ms"],
    }
    assert all(len(frame) == 1024 and encoding == "audio/wav" for frame, encoding in provider.audio)
    assert provider.closed is True


def test_stt_probe_provider_error_is_failure_and_never_counts_as_event():
    provider = FakeProvider(stt_events=[{
        "type": "provider_error", "safe_code": "invalid_audio_encoding",
        "websocket_close_code": 4400,
    }])
    result = asyncio.run(voice_provider_probe.run_probe(options(), lambda: provider))
    assert result["ok"] is False
    assert result["stt"]["classification"] == "provider_error"
    assert result["stt"]["speech_event_received"] is False
    assert result["stt"]["transcript_event_received"] is False
    assert result["stt"]["provider_safe_code"] == "invalid_audio_encoding"
    assert result["stt"]["provider_close_code"] == 4400


def test_both_probe_does_not_treat_tts_success_as_stt_success():
    provider = FakeProvider(
        stt_events=[{"type": "provider_error", "safe_code": "invalid_message"}],
        tts_chunks=[b"generated-but-never-printed"],
    )
    result = asyncio.run(voice_provider_probe.run_probe(options("both"), lambda: provider))
    assert result["stt"]["ok"] is False
    assert result["tts"]["ok"] is True
    assert result["tts"]["config_sent"] is True
    assert result["tts"]["flush_sent"] is True
    assert result["ok"] is False
    assert "generated-but-never-printed" not in str(result)


def test_tts_only_probe_requires_audio_and_completion():
    successful = asyncio.run(voice_provider_probe.run_probe(
        options("tts", "pcm_s16le"), lambda: FakeProvider(tts_chunks=[b"audio"]),
    ))
    empty = asyncio.run(voice_provider_probe.run_probe(
        options("tts"), lambda: FakeProvider(tts_chunks=[]),
    ))
    assert successful["ok"] is True
    assert successful["tts"]["completion_event_received"] is True
    assert empty["ok"] is False
