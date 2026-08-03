import logging
import json
from dataclasses import replace

import httpx
import pytest

from app.ai.model_health import (
    clear_model_health, is_model_temporarily_unavailable,
)
from app.ai.completion_quality import incomplete_markdown_reason
from app.ai.openai_reasoning import (
    OpenAIReasoningEffortConfigurationError, openai_web_reasoning_effort,
)
from app.ai.providers.base import (
    GenerationIncomplete, ProviderSafetyRejected, ProviderStreamInterrupted,
)
from app.ai.providers.openai_provider import OpenAIProvider, _response_contains_refusal
from app.ai.types import AIRequest, AIRoute
from app.database import SessionLocal
from app.models import OpenAIUsageLog
from app.openai_tracked import (
    OpenAIBudgetExceededError,
    get_tracked_chat_completion_metadata,
    tracked_openai_generation,
)
from app.observability import JsonFormatter
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


def test_provider_refusal_raises_stable_internal_safety_signal():
    refusal = type(
        "Event", (), {
            "type":"response.refusal.delta",
            "delta":"external provider refusal with https://provider.invalid/policy",
            "response":None,
        },
    )()
    client = _Client()
    client.responses = _Recorder([
        refusal, _terminal_event(_final(text="")),
    ])
    with pytest.raises(ProviderSafetyRejected) as excinfo:
        OpenAIProvider(client).stream_complete(
            _request(), _route(), lambda _delta: None,
        )
    assert "provider.invalid" not in str(excinfo.value)


def test_nonstreaming_refusal_blocks_are_detected_without_reading_their_text():
    response = {
        "output":[{"content":[{
            "type":"refusal", "refusal":"unsafe external wording",
        }]}],
    }
    assert _response_contains_refusal(response) is True


def test_stream_budget_rejection_makes_zero_provider_calls(monkeypatch):
    monkeypatch.setenv("OPENAI_DAILY_BUDGET_USD", "0.000000000001")
    client = _Client()

    with pytest.raises(OpenAIBudgetExceededError):
        OpenAIProvider(client).stream_complete(
            _request("normal"),
            _route(),
            lambda _delta: pytest.fail(
                "budget rejection must not emit output"
            ),
        )

    assert client.responses.calls == []
    assert client.completions.calls == []
    assert not is_model_temporarily_unavailable(
        "openai", "gpt-5.4-mini", "responses"
    )
    with SessionLocal() as session:
        assert session.exec(select(OpenAIUsageLog)).all() == []


@pytest.mark.parametrize(
    ("text", "answer_class", "reason"),
    [
        ("### Cell 3 — Database\n\n```python\n", "long_form", "empty_final_code_block"),
        ("### Cell 3 — Database\n\n```python\n```", "long_form", "empty_final_code_block"),
        ("```python\nprint('partial')", "detailed", "unmatched_code_fence"),
        ("## Step 4 — Deploy", "long_form", "dangling_section_heading"),
        ("Plan:\n\n-", "detailed", "unfinished_list_marker"),
        ("Use `inline code` in prose.", "long_form", ""),
        ("Step 4 is complete and the service is ready.", "long_form", ""),
        ("```python\nprint('done')\n```", "long_form", ""),
        ("A normal short answer.", "simple", ""),
    ],
)
def test_structural_completion_quality_is_conservative(
    text, answer_class, reason
):
    assert incomplete_markdown_reason(text, answer_class) == reason


def test_completed_stream_with_unfinished_fence_is_locally_truncated_once(
    monkeypatch,
):
    text = (
        "### Cell 3 — Create and use the local SQLite database\n\n"
        "```python\n"
    )
    client = _Client()
    client.responses = _Recorder([_terminal_event(_final(text=text))])
    output = []
    request = _request("long_form")
    request.metadata["max_provider_attempts"] = 2
    monkeypatch.setenv("WEB_MODEL_LADDER_DOWNGRADE_ENABLED", "true")

    response = OpenAIProvider(client).stream_complete(
        request,
        _route(["gpt-5.4-mini", "gpt-5.4-nano"]),
        output.append,
    )

    assert len(client.responses.calls) == 1
    assert output == [text.strip()]
    assert response.text == text.strip()
    assert response.raw["truncated"] is True
    assert response.raw["completion_status"] == "incomplete"
    assert response.raw["finish_reason"] == "local_incomplete"
    assert response.raw["incomplete_reason"] == "empty_final_code_block"
    assert response.raw["provider_finish_reason"] == "stop"
    assert response.raw["provider_completion_status"] == "complete"


def test_completed_balanced_markdown_stream_remains_complete():
    text = "### Cell 3\n\n```python\nprint('done')\n```"
    client = _Client()
    client.responses = _Recorder([_terminal_event(_final(text=text))])

    response = OpenAIProvider(client).stream_complete(
        _request("long_form"), _route(), lambda _delta: None
    )

    assert response.raw["truncated"] is False
    assert response.raw["completion_status"] == "complete"
    assert response.raw["finish_reason"] == "stop"
    assert response.raw["incomplete_reason"] == ""


def test_non_streaming_completed_unfinished_heading_is_locally_truncated():
    client = _Client()
    client.responses = _Recorder(
        _final(text="## Section 7 — Production deployment")
    )

    response = OpenAIProvider(client).complete(
        _request("long_form"), _route()
    )

    assert response.raw["truncated"] is True
    assert response.raw["completion_status"] == "incomplete"
    assert response.raw["incomplete_reason"] == "dangling_section_heading"
    assert response.raw["provider_finish_reason"] == "stop"


def test_local_structural_log_contains_metadata_but_not_content(caplog):
    prompt = "private prompt sk-local-structural"
    answer = "private visible answer\n\n```python"
    client = _Client()
    client.responses = _Recorder([_terminal_event(_final(text=answer))])
    caplog.set_level(logging.INFO)

    OpenAIProvider(client).stream_complete(
        _request("long_form", message=prompt),
        _route(),
        lambda _delta: None,
    )

    records = [
        record.__dict__
        for record in caplog.records
        if getattr(record, "event", "")
        == "openai_local_structural_incomplete"
    ]
    assert len(records) == 1
    assert records[0]["local_incomplete_reason"] == (
        "empty_final_code_block"
    )
    assert records[0]["provider_completion_status"] == "complete"
    assert prompt not in str(records)
    assert answer not in str(records)
    assert "sk-local-structural" not in str(records)
    rendered = json.loads(JsonFormatter().format(next(
        record
        for record in caplog.records
        if getattr(record, "event", "")
        == "openai_local_structural_incomplete"
    )))
    assert rendered["answer_class"] == "long_form"
    assert rendered["request_id"] == "responses-policy"
    assert rendered["provider_completion_status"] == "complete"
    assert rendered["provider_finish_reason"] == "stop"
    assert rendered["local_incomplete_reason"] == (
        "empty_final_code_block"
    )
    assert rendered["visible_output_characters"] == len(answer)
    assert rendered["output_tokens"] == 8
    assert rendered["max_output_tokens"] == 40
    assert prompt not in json.dumps(rendered)
    assert answer not in json.dumps(rendered)


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
        ("long_form", "none"),
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
        ("long_form", "none"),
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


def test_bounded_long_form_reserves_visible_output_capacity(monkeypatch):
    monkeypatch.setenv("OPENAI_REASONING_EFFORT_LONG_FORM", "low")
    assert openai_web_reasoning_effort(
        "long_form", max_output_tokens=1200
    ) == "none"
    assert openai_web_reasoning_effort(
        "long_form", max_output_tokens=2400
    ) == "none"
    assert openai_web_reasoning_effort(
        "long_form", max_output_tokens=4000
    ) == "low"

    client = _Client()
    client.responses = _Recorder([_terminal_event(_final())])
    route = replace(_route(), max_output_tokens=2400)
    OpenAIProvider(client).stream_complete(
        _request("long_form"), route, lambda _delta: None
    )
    assert client.responses.calls[0]["reasoning"] == {"effort": "none"}


def test_strict_visible_contract_disables_reasoning_for_visible_reserve():
    assert openai_web_reasoning_effort(
        "normal",
        max_output_tokens=420,
        strict_visible_format=True,
        minimum_visible_output_tokens=228,
    ) == "none"


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


def test_responses_completed_terminal_survives_trailing_protocol_error():
    final = _final(text="captured answer")

    def events():
        yield _terminal_event(final)
        raise httpx.RemoteProtocolError("incomplete chunked read")

    client = _Client()
    client.responses = _Recorder(events())
    output = []

    response = OpenAIProvider(client).stream_complete(
        _request(), _route(), output.append
    )

    assert response.text == "captured answer"
    assert output == ["captured answer"]
    assert len(client.responses.calls) == 1


def test_responses_protocol_error_after_delta_does_not_retry_or_duplicate():
    delta = type(
        "Event",
        (),
        {
            "type": "response.output_text.delta",
            "delta": "partial",
            "response": None,
        },
    )()

    def events():
        yield delta
        raise httpx.RemoteProtocolError("incomplete chunked read")

    client = _Client()
    client.responses = _SequenceRecorder([
        events(),
        [_terminal_event(_final(text="must not run"))],
    ])
    request = _request()
    request.metadata.update({
        "client_surface": "web",
        "max_provider_attempts": 2,
    })
    output = []

    with pytest.raises(ProviderStreamInterrupted) as excinfo:
        OpenAIProvider(client).stream_complete(
            request,
            _route(["gpt-5.4-mini", "gpt-5.4-nano"]),
            output.append,
        )

    assert output == ["partial"]
    assert len(client.responses.calls) == 1
    assert excinfo.value.response is not None
    assert excinfo.value.response.text == "partial"


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
