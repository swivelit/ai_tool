from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.ai.providers.base import GenerationCancellation, GenerationCancelled
from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.providers.sarvam_provider import SarvamProvider
from app.ai.types import AIRequest, AIRoute


def request(signal=None):
    metadata = {"cancellation_signal": signal} if signal else {}
    return AIRequest(1, "Explain indexes", "en", "text", "stream-test", metadata)


def route(provider="openai"):
    model = "gpt-4o-mini" if provider == "openai" else "sarvam-30b"
    return AIRoute(provider, model, f"{provider}_general", "test", "en", "general", 100, provider_endpoint_candidates=["chat_completions"])


def chunk(text="", usage=None):
    delta = SimpleNamespace(content=text)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)] if text else [], usage=usage)


class Stream:
    def __init__(self, values, signal=None, cancel_before_stop=False):
        self.values = iter(values); self.signal = signal; self.cancel_before_stop = cancel_before_stop; self.closed = False
    def __iter__(self): return self
    def __next__(self):
        try: return next(self.values)
        except StopIteration:
            if self.cancel_before_stop and self.signal: self.signal.cancel()
            raise
    def close(self): self.closed = True


def openai_client(stream):
    completions = SimpleNamespace(create=lambda **_kwargs: stream)
    return SimpleNamespace(chat=SimpleNamespace(completions=completions))


def test_openai_fallback_stream_usage_is_marked_estimated():
    response = OpenAIProvider(openai_client(Stream([chunk("hello")]))).stream_complete(request(), route(), lambda _value: None)
    assert response.text == "hello"
    assert response.input_tokens > 0 and response.output_tokens > 0
    assert response.raw["usage_actual"] is False


def test_openai_provider_stream_usage_is_marked_actual():
    usage = SimpleNamespace(prompt_tokens=12, completion_tokens=4, prompt_tokens_details=SimpleNamespace(cached_tokens=2))
    response = OpenAIProvider(openai_client(Stream([chunk("hello"), chunk(usage=usage)]))).stream_complete(request(), route(), lambda _value: None)
    assert response.input_tokens == 12 and response.output_tokens == 4
    assert response.raw["usage_actual"] is True


def test_cancellation_before_output_has_no_billable_response():
    signal = GenerationCancellation(); signal.cancel()
    with pytest.raises(GenerationCancelled) as caught:
        OpenAIProvider(openai_client(Stream([]))).stream_complete(request(signal), route(), lambda _value: None)
    assert caught.value.response is None


def test_cancellation_after_partial_output_returns_estimated_partial_usage():
    signal = GenerationCancellation(); output = []
    class PartialStream(Stream):
        def __next__(self):
            value = super().__next__()
            if output: signal.cancel()
            return value
    with pytest.raises(GenerationCancelled) as caught:
        OpenAIProvider(openai_client(PartialStream([chunk("one"), chunk("two")]))).stream_complete(request(signal), route(), output.append)
    assert output == ["one"]
    assert caught.value.response.text == "one"
    assert caught.value.response.raw["usage_actual"] is False


def test_cancellation_after_provider_completion_keeps_completed_response():
    signal = GenerationCancellation()
    response = OpenAIProvider(openai_client(Stream([chunk("done")], signal, cancel_before_stop=True))).stream_complete(request(signal), route(), lambda _value: None)
    assert response.text == "done" and response.raw["usage_actual"] is False


def test_sarvam_partial_stream_never_appends_non_stream_fallback():
    output = []
    def broken():
        yield {"choices": [{"delta": {"content": "partial"}}]}
        raise TypeError("SDK stream broke")
    calls = {"count": 0}
    def completions(**_kwargs):
        calls["count"] += 1
        return broken()
    provider = SarvamProvider(client=SimpleNamespace(chat=SimpleNamespace(completions=completions)))
    with pytest.raises(HTTPException):
        provider.stream_complete(request(), route("sarvam"), output.append)
    assert output == ["partial"] and calls["count"] == 1


def test_sarvam_sdk_without_streaming_falls_back_once():
    output = []; calls = []
    def completions(**kwargs):
        calls.append(kwargs)
        if kwargs.get("stream"): raise TypeError("stream unsupported")
        return {"choices": [{"message": {"content": "complete once"}}]}
    provider = SarvamProvider(client=SimpleNamespace(chat=SimpleNamespace(completions=completions)))
    response = provider.stream_complete(request(), route("sarvam"), output.append)
    assert response.text == "complete once" and output == ["complete once"] and len(calls) == 2
    assert response.raw["usage_actual"] is False
