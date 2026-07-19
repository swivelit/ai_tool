from app.ai.orchestrator import run_text_turn
from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.types import AIRequest
from app.database import SessionLocal


class _Usage:
    input_tokens = 20
    output_tokens = 80


class _Response:
    usage = _Usage()
    output_text = (
        "For this mobile app: use a backend API gateway, then an AI router/orchestrator "
        "that chooses managed multilingual speech and language models and intelligently routes "
        "English/reasoning requests. Add cache, memory/RAG, usage/cost logging, secure auth, "
        "rate limits, and safety checks."
    )


class _Endpoint:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _Response()


class _Client:
    def __init__(self):
        self.responses = _Endpoint()
        self.chat = type("Chat", (), {"completions": _Endpoint()})()


def test_architecture_answer_is_prompted_with_app_specific_context(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL_REASONING_PRIMARY", "gpt-5-mini")
    monkeypatch.setenv("OPENAI_MODEL_REASONING_LIGHT_PRIMARY", "gpt-4.1-mini")
    client = _Client()

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            AIRequest(1, "Design the backend architecture for my app", "en", "text", "app-arch", {}),
            existing_context={"openai_provider": OpenAIProvider(client)},
        )

    text = response.text
    assert "mobile app" in text
    assert "managed multilingual speech and language models" in text
    assert "intelligently routes" in text
    assert "AI router" in text or "orchestrator" in text
    assert "cache" in text
    assert "usage/cost logging" in text
    assert "secure auth" in text
    assert not text.startswith("Client Layer / API Gateway / Application Layer")

    call = client.responses.calls[0]
    instructions = call["instructions"]
    assert "backend-first AI control plane" in instructions
    assert "managed large language and speech models" in instructions
    assert "intelligent model routing" in instructions
    assert "OpenAI" not in instructions
    assert "Sarvam" not in instructions
    assert len(text) < 420
