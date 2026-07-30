from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app.ai.providers.base import (
    GenerationCancellation, GenerationCancelled, ProviderStreamInterrupted,
)
from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.providers.sarvam_provider import SarvamProvider
from app.ai.types import AIRequest, AIRoute


def request(signal=None):
    metadata = {"client_surface": "web", "max_provider_attempts": 2}
    if signal:
        metadata["cancellation_signal"] = signal
    return AIRequest(1, "Explain indexes", "en", "text", "stream-test", metadata)


def route(provider="openai", models=None):
    model = "gpt-4o-mini" if provider == "openai" else "sarvam-30b"
    candidates = models or [model]
    return AIRoute(
        provider, candidates[0], f"{provider}_general", "test", "en",
        "general", 100, model_candidates=candidates,
        provider_endpoint_candidates=["chat_completions"] * len(candidates),
    )


def chunk(text="", usage=None, finish_reason=None):
    delta = SimpleNamespace(content=text)
    choices = (
        [SimpleNamespace(delta=delta, finish_reason=finish_reason)]
        if text or finish_reason else []
    )
    return SimpleNamespace(choices=choices, usage=usage)


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


def openai_sequence_client(streams):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        return streams.pop(0)

    completions = SimpleNamespace(create=create)
    return SimpleNamespace(chat=SimpleNamespace(completions=completions)), calls


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


def test_successful_web_stream_uses_one_provider_attempt():
    client, calls = openai_sequence_client(
        [Stream([chunk("hello", finish_reason="stop")])]
    )
    output = []

    response = OpenAIProvider(client).stream_complete(
        request(), route(models=["gpt-4o-mini", "gpt-4.1-mini"]),
        output.append,
    )

    assert response.text == "hello"
    assert output == ["hello"]
    assert len(calls) == 1
    assert response.raw["provider_attempts"] == 1


def test_remote_protocol_error_before_output_falls_back_once():
    def interrupted():
        raise httpx.RemoteProtocolError("incomplete chunked read")
        yield  # pragma: no cover

    client, calls = openai_sequence_client([
        interrupted(),
        Stream([chunk("fallback", finish_reason="stop")]),
    ])
    output = []

    response = OpenAIProvider(client).stream_complete(
        request(), route(models=["gpt-4o-mini", "gpt-4.1-mini"]),
        output.append,
    )

    assert response.text == "fallback"
    assert output == ["fallback"]
    assert len(calls) == 2
    assert response.raw["fallback_attempted"] is True


def test_trailing_remote_protocol_error_after_terminal_is_success():
    def completed_then_broken():
        yield chunk("complete", finish_reason="stop")
        raise httpx.RemoteProtocolError("incomplete chunked read")

    client, calls = openai_sequence_client([completed_then_broken()])
    output = []

    response = OpenAIProvider(client).stream_complete(
        request(), route(), output.append
    )

    assert response.text == "complete"
    assert output == ["complete"]
    assert len(calls) == 1


def test_remote_protocol_error_after_visible_output_is_retryable_without_replay():
    def partial_then_broken():
        yield chunk("partial")
        raise httpx.RemoteProtocolError("incomplete chunked read")

    client, calls = openai_sequence_client([
        partial_then_broken(),
        Stream([chunk("must not run", finish_reason="stop")]),
    ])
    output = []

    with pytest.raises(ProviderStreamInterrupted) as excinfo:
        OpenAIProvider(client).stream_complete(
            request(), route(models=["gpt-4o-mini", "gpt-4.1-mini"]),
            output.append,
        )

    assert output == ["partial"]
    assert len(calls) == 1
    assert excinfo.value.response is not None
    assert excinfo.value.response.text == "partial"
    assert excinfo.value.metadata["visible_output_emitted"] is True


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
