from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.model_health import clear_model_health
from app.ai.router import AIProviderRouter
from app.ai.types import AIRequest


class _Usage:
    input_tokens = 12
    output_tokens = 30


class _Response:
    usage = _Usage()

    def __init__(self, text: str):
        self.output_text = text


class _Endpoint:
    def __init__(self, text: str):
        self.text = text
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _Response(self.text)


class _Client:
    def __init__(self, text: str):
        self.responses = _Endpoint(text)
        self.chat = type("Chat", (), {"completions": _Endpoint(text)})()


def _request(message: str) -> AIRequest:
    return AIRequest(1, message, "en", "text", "style-test", {})


def test_compiler_answer_uses_mobile_concise_policy(monkeypatch):
    clear_model_health("openai")
    monkeypatch.setenv("AI_DEFAULT_ANSWER_STYLE", "mobile_concise")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_PRIMARY", "gpt-5-nano")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_FALLBACKS", "gpt-4.1-nano,gpt-4o-mini")
    route = AIProviderRouter().select_route(_request("What is a compiler?"))
    client = _Client("A compiler translates source code into code a computer can run.")

    response = OpenAIProvider(client).complete(_request("What is a compiler?"), route)

    assert route.max_output_tokens <= 240
    assert response.text.count("\n") == 0
    assert "one short paragraph" in client.responses.calls[0]["instructions"]


def test_architecture_answer_default_is_concise_but_structured(monkeypatch):
    monkeypatch.setenv("AI_DEFAULT_ANSWER_STYLE", "mobile_concise")
    route = AIProviderRouter().select_route(_request("Design the backend architecture for my app"))

    assert route.max_output_tokens <= 240
    assert route.intent == "complex_reasoning"


def test_detailed_trigger_allows_longer_answer(monkeypatch):
    monkeypatch.setenv("AI_DEFAULT_ANSWER_STYLE", "mobile_concise")
    concise = AIProviderRouter().select_route(_request("Design the backend architecture for my app"))
    detailed = AIProviderRouter().select_route(_request("Give full detailed architecture for my app"))

    assert detailed.max_output_tokens > concise.max_output_tokens
    assert detailed.max_output_tokens >= 700
