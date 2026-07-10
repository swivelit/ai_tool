import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import app.ai.providers.sarvam_provider as sarvam_provider_module
from app.ai.providers.sarvam_provider import (
    SARVAM_TTS_BULBUL_V2_SPEAKERS,
    SARVAM_STT_ACCEPTED_UPLOAD_MIME_TYPES,
    SARVAM_STT_EMPTY_TRANSCRIPT_DETAIL,
    SarvamProvider,
    resolve_sarvam_tts_voice,
)
from app.ai.types import AIRequest, AIRoute


class _FakeCompletions:
    def __init__(self):
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return {"choices": [{"message": {"content": "வணக்கம்"}}]}


class _BlankCompletions:
    def __call__(self, **_kwargs):
        return {"choices": [{"message": {"content": "   "}}]}


def test_sarvam_chat_uses_sdk_client_without_real_network(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    completions = _FakeCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    provider = SarvamProvider(client=client)

    response = provider.complete(
        AIRequest(1, "வணக்கம்", "ta", "text", "sarvam-test", {}),
        AIRoute("sarvam", "sarvam-30b", "sarvam_general", "test", "ta", "general", 100),
    )

    assert response.text == "வணக்கம்"
    assert response.provider == "sarvam"
    assert completions.calls[0]["model"] == "sarvam-30b"
    assert completions.calls[0]["messages"][1]["content"] == "வணக்கம்"


def test_direct_sarvam_complete_records_once_through_optional_hook(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    completions = _FakeCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    recorder_calls = []
    provider = SarvamProvider(client=client, cache_recorder=lambda request, route, response: recorder_calls.append((request, route, response)))

    response = provider.complete(
        AIRequest(1, "What is photosynthesis?", "en", "text", "sarvam-hook-test", {}),
        AIRoute("sarvam", "sarvam-30b", "sarvam_general", "test", "en", "general", 100),
    )

    assert response.provider == "sarvam"
    assert len(recorder_calls) == 1
    assert recorder_calls[0][2] is response


def test_direct_sarvam_complete_without_hook_is_not_hidden_cache_write_path(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    completions = _FakeCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    provider = SarvamProvider(client=client)

    response = provider.complete(
        AIRequest(1, "What is photosynthesis?", "en", "text", "sarvam-no-hook-test", {}),
        AIRoute("sarvam", "sarvam-30b", "sarvam_general", "test", "en", "general", 100),
    )

    assert response.provider == "sarvam"
    assert completions.calls


def test_sarvam_chat_gets_english_only_instruction_for_english_reply(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    completions = _FakeCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    provider = SarvamProvider(client=client)

    provider.complete(
        AIRequest(1, "நாளைக்கு என்ன செய்யலாம்?", "en", "text", "sarvam-test", {}),
        AIRoute("sarvam", "sarvam-30b", "sarvam_general", "test", "en", "general", 100),
    )

    system_prompt = completions.calls[0]["messages"][0]["content"]
    assert "understand the Tamil/Tanglish user input but answer only in English" in system_prompt
    assert "answer only in English" in system_prompt


def test_sarvam_chat_gets_chennai_tamil_style_instruction_for_tamil_reply(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    completions = _FakeCompletions()
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    provider = SarvamProvider(client=client)

    provider.complete(
        AIRequest(1, "Explain photosynthesis", "ta", "text", "sarvam-test", {}),
        AIRoute("sarvam", "sarvam-30b", "sarvam_general", "test", "ta", "general", 100),
    )

    system_prompt = completions.calls[0]["messages"][0]["content"]
    assert "Chennai Tamil/Tanglish" in system_prompt


def test_sarvam_chat_missing_key_is_sanitized(monkeypatch):
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    provider = SarvamProvider()

    with pytest.raises(HTTPException) as exc:
        provider.complete(
            AIRequest(1, "hello", "ta", "text", "sarvam-test", {}),
            AIRoute("sarvam", "sarvam-30b", "sarvam_general", "test", "ta", "general", 100),
        )

    assert exc.value.status_code == 503
    assert "SARVAM_API_KEY" in exc.value.detail


def test_sarvam_empty_chat_response_raises_for_orchestrator_fallback(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    client = SimpleNamespace(chat=SimpleNamespace(completions=_BlankCompletions()))
    provider = SarvamProvider(client=client)

    with pytest.raises(HTTPException) as exc:
        provider.complete(
            AIRequest(1, "Tamil la sollu", "ta", "text", "sarvam-test", {}),
            AIRoute("sarvam", "sarvam-30b", "sarvam_translation", "test", "ta", "translation", 100),
        )

    assert exc.value.status_code == 502
    assert getattr(exc.value, "metadata")["provider_error_type"] == "empty_sarvam_response"


def test_sarvam_tts_modern_payload_and_audio(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.delenv("SARVAM_TTS_MODEL", raising=False)
    monkeypatch.delenv("SARVAM_TTS_SPEAKER", raising=False)
    calls = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"audios": ["audio64"]}

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        return Response()

    audio = SarvamProvider(http_post=fake_post).tts("hello", target_language_code="en-IN")

    assert audio == "audio64"
    assert calls[0][1]["json"]["text"] == "hello"
    assert calls[0][1]["json"]["model"] == "bulbul:v2"
    assert calls[0][1]["json"]["speaker"] == "anushka"
    assert "inputs" not in calls[0][1]["json"]
    assert calls[0][1]["headers"]["api-subscription-key"] == "test-key"


def test_sarvam_tts_env_shubh_falls_back_for_bulbul_v2(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")
    monkeypatch.setenv("SARVAM_TTS_SPEAKER", "shubh")
    calls = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"audios": ["audio64"]}

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        return Response()

    audio = SarvamProvider(http_post=fake_post).tts("hello", target_language_code="en-IN")

    assert audio == "audio64"
    assert calls[0][1]["json"]["speaker"] == "anushka"


def test_sarvam_tts_preserves_valid_v2_speaker(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")
    calls = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"audios": ["audio64"]}

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        return Response()

    audio = SarvamProvider(http_post=fake_post).tts("hello", speaker="vidya")

    assert audio == "audio64"
    assert calls[0][1]["json"]["speaker"] == "vidya"


def test_sarvam_tts_en_in_uses_english_voice_resolver(monkeypatch):
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")
    monkeypatch.delenv("SARVAM_TTS_SPEAKER", raising=False)
    monkeypatch.delenv("SARVAM_TTS_SPEAKER_EN", raising=False)

    voice = resolve_sarvam_tts_voice("en-IN")

    assert voice["target_language_code"] == "en-IN"
    assert voice["speaker"] == "anushka"
    assert voice["speaker"] in SARVAM_TTS_BULBUL_V2_SPEAKERS
    assert voice["style"] == "indian_english"
    assert voice["pace"] == 0.95


def test_sarvam_tts_ta_in_uses_tamil_voice_resolver(monkeypatch):
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")
    monkeypatch.delenv("SARVAM_TTS_SPEAKER", raising=False)
    monkeypatch.delenv("SARVAM_TTS_SPEAKER_TA", raising=False)

    voice = resolve_sarvam_tts_voice("ta-IN")

    assert voice["target_language_code"] == "ta-IN"
    assert voice["speaker"] == "karun"
    assert voice["speaker"] in SARVAM_TTS_BULBUL_V2_SPEAKERS
    assert voice["style"] == "local_tamil"
    assert voice["pace"] == 0.9


def test_sarvam_tts_invalid_tamil_speaker_falls_back_to_v2_compatible(monkeypatch):
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")

    voice = resolve_sarvam_tts_voice("ta-IN", "shubh")

    assert voice["speaker"] == "karun"
    assert voice["speaker"] in SARVAM_TTS_BULBUL_V2_SPEAKERS


def test_sarvam_tts_invalid_english_speaker_falls_back_to_v2_compatible(monkeypatch):
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")

    voice = resolve_sarvam_tts_voice("en-IN", "shubh")

    assert voice["speaker"] == "anushka"
    assert voice["speaker"] in SARVAM_TTS_BULBUL_V2_SPEAKERS


def test_sarvam_tts_never_sends_shubh_with_bulbul_v2(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")
    monkeypatch.setenv("SARVAM_TTS_SPEAKER_TA", "shubh")
    calls = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"audios": ["audio64"]}

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        return Response()

    audio = SarvamProvider(http_post=fake_post).tts("hello", target_language_code="ta-IN")

    assert audio == "audio64"
    assert calls[0][1]["json"]["model"] == "bulbul:v2"
    assert calls[0][1]["json"]["speaker"] != "shubh"
    assert calls[0][1]["json"]["speaker"] == "karun"
    assert calls[0][1]["json"]["target_language_code"] == "ta-IN"


def test_sarvam_tts_retries_speaker_mismatch(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")
    monkeypatch.setattr(
        sarvam_provider_module,
        "SARVAM_TTS_BULBUL_V2_SPEAKERS",
        {*sarvam_provider_module.SARVAM_TTS_BULBUL_V2_SPEAKERS, "shubh"},
    )
    calls = []

    class Response:
        def __init__(self, status_code: int, payload: dict | None = None, text: str = ""):
            self.status_code = status_code
            self._payload = payload or {}
            self.text = text

        def json(self):
            return self._payload

    mismatch_text = (
        "Speaker 'shubh' is not compatible with model bulbul:v2. "
        "Available speakers for bulbul:v2 are: anushka, abhilash, manisha, vidya, arya, karun, hitesh"
    )

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        if len(calls) == 1:
            return Response(400, {"detail": mismatch_text}, mismatch_text)
        return Response(200, {"audios": ["audio64"]})

    audio = SarvamProvider(http_post=fake_post).tts("hello", speaker="shubh")

    assert audio == "audio64"
    assert len(calls) == 2
    assert calls[0][1]["json"]["speaker"] == "shubh"
    assert calls[1][1]["json"]["speaker"] == "karun"


@pytest.mark.skipif(
    os.getenv("RUN_LIVE_SARVAM_TTS_TEST") != "1" or not os.getenv("SARVAM_API_KEY"),
    reason="Set RUN_LIVE_SARVAM_TTS_TEST=1 and SARVAM_API_KEY to run the live Sarvam TTS smoke test.",
)
def test_live_sarvam_tts_default_v2_smoke(monkeypatch):
    monkeypatch.setenv("SARVAM_TTS_MODEL", "bulbul:v2")
    audio = SarvamProvider().tts("hello", target_language_code="ta-IN")

    assert str(audio or "").strip()


def test_sarvam_stt_extracts_transcript(monkeypatch, tmp_path):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    audio_file = tmp_path / "audio.m4a"
    audio_file.write_bytes(b"audio")
    calls = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"transcript": "voice hello"}

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        return Response()

    transcript = SarvamProvider(http_post=fake_post).stt_file(
        str(audio_file),
        "ta",
        content_type="audio/m4a",
        filename="audio.m4a",
    )

    assert transcript == "voice hello"
    assert calls[0][1]["data"]["model"] == "saaras:v3"
    assert calls[0][1]["data"]["mode"] == "transcribe"
    assert calls[0][1]["data"]["language_code"] == "ta-IN"
    file_tuple = calls[0][1]["files"]["file"]
    assert len(file_tuple) == 3
    assert file_tuple[0].endswith(".m4a")
    assert file_tuple[2] is not None
    assert file_tuple[2] in SARVAM_STT_ACCEPTED_UPLOAD_MIME_TYPES


def test_sarvam_stt_empty_transcript_raises_actionable_422(monkeypatch, tmp_path):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    audio_file = tmp_path / "audio.m4a"
    audio_file.write_bytes(b"audio")

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"transcript": ""}

    def fake_post(*args, **kwargs):
        return Response()

    with pytest.raises(HTTPException) as exc:
        SarvamProvider(http_post=fake_post).stt_file(
            str(audio_file),
            "ta",
            content_type="audio/m4a",
            filename="audio.m4a",
        )

    assert exc.value.status_code == 422
    assert exc.value.detail == SARVAM_STT_EMPTY_TRANSCRIPT_DETAIL


def test_sarvam_stt_unknown_mobile_audio_gets_octet_stream(monkeypatch, tmp_path):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    audio_file = tmp_path / "mobile-upload.bin"
    audio_file.write_bytes(b"audio")
    calls = []

    class Response:
        status_code = 200
        text = ""

        def json(self):
            return {"transcript": "voice hello"}

    def fake_post(*args, **kwargs):
        calls.append((args, kwargs))
        return Response()

    transcript = SarvamProvider(http_post=fake_post).stt_file(
        str(audio_file),
        "ta",
        content_type=None,
        filename="audio",
    )

    assert transcript == "voice hello"
    file_tuple = calls[0][1]["files"]["file"]
    assert len(file_tuple) == 3
    assert file_tuple[2] == "application/octet-stream"
