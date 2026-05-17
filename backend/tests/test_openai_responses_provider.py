from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.types import AIRequest, AIRoute
from app.openai_tracked import get_tracked_chat_completion_metadata, tracked_openai_generation


class _Usage:
    input_tokens = 12
    output_tokens = 5
    total_tokens = 17


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


class _Client:
    def __init__(self):
        self.responses = _Recorder(_ResponsesResponse())
        self.completions = _Recorder(_ChatResponse())
        self.chat = type("Chat", (), {"completions": self.completions})()


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

