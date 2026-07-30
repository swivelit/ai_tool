import logging

import pytest

from app.ai.model_health import (
    clear_model_health, is_model_temporarily_unavailable,
)
from app.ai.openai_reasoning import (
    OpenAIReasoningEffortConfigurationError, openai_web_reasoning_effort,
)
from app.ai.providers.base import GenerationIncomplete
from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.types import AIRequest, AIRoute
from app.database import SessionLocal
from app.models import OpenAIUsageLog
from app.openai_tracked import get_tracked_chat_completion_metadata, tracked_openai_generation
from sqlmodel import select


class _Usage:
    input_tokens = 12
    output_tokens = 5
    total_tokens = 17
    output_tokens_details = type(
        "OutputDetails", (), {"reasoning_tokens": 3}
    )()


class _ResponsesResponse:
    output_text = "responses answer"
    usage = _Usage()


class _Message:
    content = "chat answer"


class _Choice:
    message = _Message()


class _ChatResponse:
    choices = [_Choice()]
    usage = _Usage()


class _Recorder:
    def __init__(self, response):
        self.calls = []
        self.response = response

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class _SequenceRecorder(_Recorder):
    def __init__(self, outcomes):
        super().__init__(None)
        self.outcomes = list(outcomes)

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.outcomes.pop(0)


class _Client:
    def __init__(self):
        self.responses = _Recorder(_ResponsesResponse())
        self.completions = _Recorder(_ChatResponse())
        self.chat = type("Chat", (), {"completions": self.completions})()


def _request(answer_class="normal", *, message="Explain"):
    metadata = {"max_provider_attempts": 1}
    if answer_class is not None:
        metadata["answer_class"] = answer_class
    return AIRequest(
        user_id=1, message=message, reply_language="en", channel="text",
        request_id="responses-policy", metadata=metadata,
    )


def _route(models=None, *, max_output_tokens=40):
    candidates = models or ["gpt-5.4-mini"]
    return AIRoute(
        provider="openai", model=candidates[0], route="openai_general",
        reason="test", language="en", intent="general",
        max_output_tokens=max_output_tokens, model_candidates=candidates,
        provider_endpoint_candidates=["responses"] * len(candidates),
        metadata={},
    )


def _final(
    *,
    text="answer",
    status="completed",
    reason="",
    input_tokens=10,
    output_tokens=8,
    reasoning_tokens=2,
):
    details = (
        type("Details", (), {"reason": reason})()
        if reason else None
    )
    usage = type(
        "Usage",
        (),
        {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "input_tokens_details": None,
            "output_tokens_details": type(
                "OutputDetails", (), {"reasoning_tokens": reasoning_tokens}
            )(),
        },
    )()
    return type(
        "Final",
        (),
        {
            "status": status,
            "output_text": text,
            "usage": usage,
            "incomplete_details": details,
        },
    )()


def _terminal_event(final, event_type="response.completed"):
    return type(
        "Event", (), {"type": event_type, "response": final}
    )()


@pytest.fixture(autouse=True)
def _clear_openai_health():
    clear_model_health("openai")
    yield
    clear_model_health("openai")


def test_responses_stream_maps_incomplete_max_output_to_truncation():
    usage = type("Usage", (), {"input_tokens": 10, "output_tokens": 8, "input_tokens_details": None})()
    incomplete = type("Final", (), {
        "status": "incomplete", "usage": usage,
        "incomplete_details": type("Details", (), {"reason": "max_output_tokens"})(),
    })()
    events = [
        type("Event", (), {"type": "response.created", "response": type("Created", (), {"status": "in_progress", "usage": None})()})(),
        type("Event", (), {"type": "response.output_text.delta", "delta": "partial answer", "response": None})(),
        type("Event", (), {"type": "response.completed", "response": incomplete})(),
    ]
    client = _Client()
    client.responses = _Recorder(events)
    route = AIRoute(
        provider="openai", model="gpt-5.4-mini", route="openai_general",
        reason="test", language="en", intent="general", max_output_tokens=8,
        model_candidates=["gpt-5.4-mini"], provider_endpoint_candidates=["responses"],
    )
    response = OpenAIProvider(client).stream_complete(
        AIRequest(
            user_id=1, message="Explain", reply_language="en", channel="text",
            request_id="truncated-stream", metadata={"max_provider_attempts": 1},
        ),
        route, lambda _delta: None,
    )
    assert response.raw["finish_reason"] == "length"
    assert response.raw["truncated"] is True
    assert response.raw["completion_status"] == "incomplete"
    assert response.text == "partial answer"


def test_web_reasoning_policy_defaults(monkeypatch):
    for answer_class in ("simple", "normal", "detailed", "long_form"):
        monkeypatch.delenv(
            f"OPENAI_REASONING_EFFORT_{answer_class.upper()}",
            raising=False,
        )

    assert openai_web_reasoning_effort("simple") == "none"
    assert openai_web_reasoning_effort("normal") == "low"
    assert openai_web_reasoning_effort("detailed") == "low"
    assert openai_web_reasoning_effort("long_form") == "low"
    assert openai_web_reasoning_effort(None) is None


@pytest.mark.parametrize(
    ("answer_class", "expected"),
    [
        ("simple", "none"),
        ("normal", "low"),
        ("detailed", "low"),
        ("long_form", "low"),
    ],
)
def test_responses_stream_uses_web_reasoning_policy(
    monkeypatch, answer_class, expected
):
    monkeypatch.setenv(
        f"OPENAI_REASONING_EFFORT_{answer_class.upper()}", expected
    )
    client = _Client()
    client.responses = _Recorder([_terminal_event(_final())])

    OpenAIProvider(client).stream_complete(
        _request(answer_class), _route(), lambda _delta: None
    )

    assert client.responses.calls[0]["reasoning"] == {"effort": expected}


@pytest.mark.parametrize(
    ("answer_class", "configured"),
    [
        ("simple", "none"),
        ("normal", "medium"),
        ("detailed", "high"),
        ("long_form", "low"),
    ],
)
def test_responses_non_streaming_uses_same_web_reasoning_policy(
    monkeypatch, answer_class, configured
):
    monkeypatch.setenv(
        f"OPENAI_REASONING_EFFORT_{answer_class.upper()}", configured
    )
    client = _Client()

    tracked_openai_generation(
        client,
        messages=[{"role": "user", "content": "Explain"}],
        task="normal_qa",
        route="unit",
        candidates=["gpt-5.4-mini"],
        max_output_tokens=40,
        answer_class=answer_class,
    )

    assert client.responses.calls[0]["reasoning"] == {
        "effort": configured
    }


def test_provider_complete_uses_answer_class_from_route_metadata():
    client = _Client()
    route = _route()
    route.metadata["answer_class"] = "detailed"

    response = OpenAIProvider(client).complete(_request(None), route)

    assert response.text == "responses answer"
    assert client.responses.calls[0]["reasoning"] == {"effort": "low"}


def test_invalid_web_reasoning_effort_is_rejected(monkeypatch):
    monkeypatch.setenv("OPENAI_REASONING_EFFORT_NORMAL", "turbo")
    client = _Client()
    client.responses = _Recorder([_terminal_event(_final())])

    with pytest.raises(OpenAIReasoningEffortConfigurationError):
        OpenAIProvider(client).stream_complete(
            _request("normal"), _route(), lambda _delta: None
        )

    assert client.responses.calls == []


def test_non_web_responses_stream_does_not_add_reasoning():
    client = _Client()
    client.responses = _Recorder([_terminal_event(_final())])

    OpenAIProvider(client).stream_complete(
        _request(None), _route(), lambda _delta: None
    )

    assert "reasoning" not in client.responses.calls[0]


def test_terminal_output_text_without_deltas_is_recovered_once():
    final = _final(text="recovered final answer")
    client = _Client()
    client.responses = _Recorder([_terminal_event(final)])
    output = []

    response = OpenAIProvider(client).stream_complete(
        _request(), _route(), output.append
    )

    assert response.text == "recovered final answer"
    assert output == ["recovered final answer"]


def test_terminal_output_text_does_not_duplicate_streamed_deltas():
    final = _final(text="streamed answer")
    delta = type(
        "Event",
        (),
        {
            "type": "response.output_text.delta",
            "delta": "streamed answer",
            "response": None,
        },
    )()
    client = _Client()
    client.responses = _Recorder([delta, _terminal_event(final)])
    output = []

    response = OpenAIProvider(client).stream_complete(
        _request(), _route(), output.append
    )

    assert response.text == "streamed answer"
    assert output == ["streamed answer"]


def test_no_visible_output_at_limit_raises_incomplete_without_fallback():
    final = _final(
        text="", status="incomplete", reason="max_output_tokens",
        output_tokens=40, reasoning_tokens=40,
    )
    client = _Client()
    client.responses = _Recorder([_terminal_event(final)])

    with pytest.raises(GenerationIncomplete) as excinfo:
        OpenAIProvider(client).stream_complete(
            _request(), _route(["gpt-5.4-mini", "gpt-5.4-nano"]),
            lambda _delta: None,
        )

    assert len(client.responses.calls) == 1
    assert excinfo.value.metadata == {
        "completion_status": "incomplete",
        "incomplete_reason": "max_output_tokens",
        "finish_reason": "length",
        "input_tokens": 10,
        "output_tokens": 40,
        "reasoning_tokens": 40,
        "visible_character_count": 0,
        "max_output_tokens": 40,
        "provider_usage_received": True,
    }
    assert not is_model_temporarily_unavailable(
        "openai", "gpt-5.4-mini", "responses"
    )
    with SessionLocal() as session:
        rows = session.exec(
            select(OpenAIUsageLog).where(
                OpenAIUsageLog.request_id == "responses-policy"
            )
        ).all()
    assert len(rows) == 1
    assert rows[0].actual_output_tokens == 40


def test_non_streaming_no_visible_output_at_limit_is_incomplete():
    client = _Client()
    client.responses = _Recorder(
        _final(
            text="", status="incomplete", reason="max_output_tokens",
            output_tokens=40, reasoning_tokens=40,
        )
    )

    with pytest.raises(GenerationIncomplete):
        OpenAIProvider(client).complete(_request(), _route())

    assert len(client.responses.calls) == 1


def test_zero_output_zero_usage_stream_failure_still_fails_over():
    client = _Client()
    client.responses = _SequenceRecorder(
        [[], [_terminal_event(_final(text="fallback answer"))]]
    )
    request = _request()
    request.metadata["max_provider_attempts"] = 2

    response = OpenAIProvider(client).stream_complete(
        request,
        _route(["gpt-5.4-mini", "gpt-5.4-nano"]),
        lambda _delta: None,
    )

    assert response.text == "fallback answer"
    assert response.raw["fallback_attempted"] is True
    assert response.raw["selected_model_reason"] == (
        "zero_output_zero_usage_failover"
    )
    assert len(client.responses.calls) == 2


def test_reasoning_tokens_are_extracted_from_responses_usage():
    client = _Client()

    response = tracked_openai_generation(
        client,
        messages=[{"role": "user", "content": "Explain"}],
        task="normal_qa",
        route="unit",
        candidates=["gpt-5.4-mini"],
        max_output_tokens=40,
        answer_class="normal",
    )

    metadata = get_tracked_chat_completion_metadata(response)
    assert metadata["reasoning_tokens"] == 3


def test_terminal_diagnostics_never_log_content_or_credentials(caplog):
    prompt = "private prompt sk-private-secret"
    final = _final(
        text="", status="incomplete", reason="max_output_tokens",
        output_tokens=40, reasoning_tokens=40,
    )
    client = _Client()
    client.responses = _Recorder([_terminal_event(final)])
    caplog.set_level(logging.INFO)

    with pytest.raises(GenerationIncomplete):
        OpenAIProvider(client).stream_complete(
            _request(message=prompt), _route(), lambda _delta: None
        )

    records = [
        record.__dict__
        for record in caplog.records
        if getattr(record, "event", "") in {
            "openai_stream_terminal",
            "openai_generation_no_visible_output",
        }
    ]
    assert records
    assert prompt not in str(records)
    assert "sk-private-secret" not in str(records)


def test_gpt5_nano_uses_responses_without_chat_only_params():
    client = _Client()

    response = tracked_openai_generation(
        client,
        messages=[{"role": "system", "content": "system"}, {"role": "user", "content": "What is a compiler?"}],
        input_text="What is a compiler?",
        instructions="system",
        task="normal_qa",
        route="unit",
        candidates=["gpt-5-nano"],
        max_output_tokens=40,
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    assert response.output_text == "responses answer"
    call = client.responses.calls[0]
    assert call["model"] == "gpt-5-nano"
    assert call["input"] == "What is a compiler?"
    assert call["max_output_tokens"] == 40
    assert call["store"] is False
    assert "response_format" not in call
    assert "temperature" not in call
    assert client.completions.calls == []
    metadata = get_tracked_chat_completion_metadata(response)
    assert metadata["endpoint"] == "responses"


def test_chat_fallback_uses_chat_endpoint_and_supported_params():
    client = _Client()

    response = tracked_openai_generation(
        client,
        messages=[{"role": "user", "content": "Hello"}],
        task="normal_qa",
        route="unit",
        candidates=["gpt-4.1-nano"],
        max_output_tokens=25,
        response_format={"type": "json_object"},
        temperature=0.2,
    )

    assert response.choices[0].message.content == "chat answer"
    call = client.completions.calls[0]
    assert call["model"] == "gpt-4.1-nano"
    assert call["max_tokens"] == 25
    assert call["temperature"] == 0.2
    assert call["response_format"] == {"type": "json_object"}
    assert "max_completion_tokens" not in call
    assert client.responses.calls == []


def test_openai_provider_respects_single_route_candidate():
    client = _Client()
    route = AIRoute(
        provider="openai",
        model="gpt-4.1-nano",
        route="openai_general",
        reason="test",
        language="en",
        intent="general",
        max_output_tokens=30,
        model_candidates=["gpt-4.1-nano"],
        provider_endpoint_candidates=["chat_completions"],
    )

    response = OpenAIProvider(client).complete(
        AIRequest(user_id=1, message="Hello", reply_language="en", channel="text", request_id="provider", metadata={}),
        route,
    )

    assert response.model == "gpt-4.1-nano"
    assert response.raw["endpoint"] == "chat_completions"
    assert client.completions.calls[0]["model"] == "gpt-4.1-nano"
    assert client.responses.calls == []
