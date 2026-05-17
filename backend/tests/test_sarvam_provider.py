from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.ai.providers.sarvam_provider import SarvamProvider
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
    assert calls[0][1]["headers"]["api-subscription-key"] == "test-key"


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

    transcript = SarvamProvider(http_post=fake_post).stt_file(str(audio_file), "ta")

    assert transcript == "voice hello"
    assert calls[0][1]["data"]["model"] == "saaras:v3"
    assert calls[0][1]["data"]["mode"] == "transcribe"
    assert calls[0][1]["data"]["language_code"] == "ta-IN"
