import logging

import pytest

from app.ai.model_health import clear_model_health, is_model_temporarily_unavailable
from app.ai.orchestrator import run_text_turn
from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.types import AIRequest, AIRoute
from app.database import SessionLocal
from app.openai_tracked import OpenAIProviderUnavailableError


class _OpenAI400(Exception):
    status_code = 400
    code = "unsupported_parameter"


class _Usage:
    input_tokens = 10
    output_tokens = 4
    total_tokens = 14


class _Response:
    def __init__(self, text: str):
        self.output_text = text
        self.usage = _Usage()


class _Message:
    def __init__(self, content: str):
        self.content = content


class _Choice:
    def __init__(self, content: str):
        self.message = _Message(content)


class _ChatResponse:
    usage = _Usage()

    def __init__(self, text: str):
        self.choices = [_Choice(text)]


class _Endpoint:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class _Client:
    def __init__(self, *, responses_outcomes, chat_outcomes):
        self.responses = _Endpoint(responses_outcomes)
        self.completions = _Endpoint(chat_outcomes)
        self.chat = type("Chat", (), {"completions": self.completions})()


def _request() -> AIRequest:
    return AIRequest(user_id=1, message="What is a compiler?", reply_language="en", channel="text", request_id="fallback", metadata={})


def _route(models, endpoints, *, intent="general") -> AIRoute:
    return AIRoute(
        provider="openai",
        model=models[0],
        route=f"openai_{intent}",
        reason="test",
        language="en",
        intent=intent,
        max_output_tokens=40,
        model_candidates=models,
        provider_endpoint_candidates=endpoints,
    )


@pytest.fixture(autouse=True)
def clear_health():
    clear_model_health("openai")
    yield
    clear_model_health("openai")


def test_gpt5_nano_400_falls_back_to_gpt41_nano():
    client = _Client(
        responses_outcomes=[_OpenAI400("bad request from sk-test-secret")],
        chat_outcomes=[_ChatResponse("cheap fallback answer")],
    )

    response = OpenAIProvider(client).complete(
        _request(),
        _route(["gpt-5-nano", "gpt-4.1-nano"], ["responses", "chat_completions"]),
    )

    assert response.text == "cheap fallback answer"
    assert response.model == "gpt-4.1-nano"
    assert response.raw["fallback_attempted"] is True
    assert response.raw["openai_attempted_models"] == ["gpt-5-nano", "gpt-4.1-nano"]
    assert response.raw["primary_model_candidate"] == "gpt-5-nano"
    assert response.raw["selected_model_reason"] == "primary_model_endpoint_error"


def test_gpt5_mini_400_falls_back_to_gpt41_mini():
    client = _Client(
        responses_outcomes=[_OpenAI400("bad request")],
        chat_outcomes=[_ChatResponse("reasoning fallback answer")],
    )

    response = OpenAIProvider(client).complete(
        _request(),
        _route(["gpt-5-mini", "gpt-4.1-mini"], ["responses", "chat_completions"], intent="complex_reasoning"),
    )

    assert response.model == "gpt-4.1-mini"
    assert response.raw["endpoint"] == "chat_completions"


def test_all_openai_candidates_fail_with_sanitized_metadata(caplog):
    provider_body = "private provider error body"
    client = _Client(
        responses_outcomes=[
            _OpenAI400(f"{provider_body} sk-test-secret")
        ],
        chat_outcomes=[
            _OpenAI400(f"second {provider_body} sk-test-secret")
        ],
    )
    caplog.set_level(logging.WARNING)

    with pytest.raises(OpenAIProviderUnavailableError) as excinfo:
        OpenAIProvider(client).complete(
            _request(),
            _route(["gpt-5-nano", "gpt-4.1-nano"], ["responses", "chat_completions"]),
        )

    metadata = excinfo.value.metadata
    assert metadata["model_candidates"] == ["gpt-5-nano", "gpt-4.1-nano"]
    assert metadata["provider_error_type"] == "_OpenAI400"
    assert metadata["primary_model_candidate"] == "gpt-5-nano"
    assert metadata["selected_model_reason"] == "primary_model_endpoint_error"
    assert "sk-test-secret" not in str(metadata)
    assert "sk-test-secret" not in caplog.text
    provider_log_records = [
        record.__dict__
        for record in caplog.records
        if getattr(record, "event", "") == "openai_provider_error"
    ]
    assert provider_log_records
    assert provider_body not in str(provider_log_records)


def test_model_health_skips_recently_failed_model():
    client = _Client(
        responses_outcomes=[_OpenAI400("bad request")],
        chat_outcomes=[_ChatResponse("fallback answer"), _ChatResponse("second answer")],
    )
    route = _route(["gpt-5-nano", "gpt-4.1-nano"], ["responses", "chat_completions"])

    first = OpenAIProvider(client).complete(_request(), route)
    second = OpenAIProvider(client).complete(_request(), route)

    assert first.model == "gpt-4.1-nano"
    assert second.model == "gpt-4.1-nano"
    assert second.raw["model_health_skip_reason"] == "primary_model_health_cache"
    assert second.raw["selected_model_reason"] == "primary_model_health_cache"
    assert is_model_temporarily_unavailable("openai", "gpt-5-nano", "responses") is True
    assert len(client.responses.calls) == 1
    assert len(client.completions.calls) == 2


def test_normal_english_turn_does_not_return_unavailable_when_openai_fallback_succeeds(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_PRIMARY", "gpt-5-nano")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_FALLBACKS", "gpt-4.1-nano,gpt-4o-mini")
    client = _Client(
        responses_outcomes=[_OpenAI400("gpt5 bad request")],
        chat_outcomes=[_ChatResponse("compiler fallback answer")],
    )

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request(),
            existing_context={"openai_provider": OpenAIProvider(client)},
        )

    assert response.provider == "openai"
    assert response.model == "gpt-4.1-nano"
    assert response.raw["selected_model_reason"] == "primary_model_endpoint_error"
    assert "temporarily unavailable" not in response.text.lower()


def test_user_facing_openai_answer_does_not_expose_model_fallback_details():
    client = _Client(
        responses_outcomes=[_OpenAI400("gpt5 bad request")],
        chat_outcomes=[_ChatResponse("A compiler translates source code.")],
    )

    response = OpenAIProvider(client).complete(
        _request(),
        _route(["gpt-5-nano", "gpt-4.1-nano"], ["responses", "chat_completions"]),
    )

    assert "gpt-5" not in response.text
    assert "model" not in response.text.lower()
