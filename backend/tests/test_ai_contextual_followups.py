import json

from sqlmodel import select

from app.ai.orchestrator import run_text_turn
from app.ai.providers.sarvam_provider import SarvamProvider
from app.ai.types import AIProviderResponse, AIRequest
from app.database import SessionLocal
from app.models import AIUsageEvent


class _StaticProvider:
    def __init__(self, text: str, provider: str = "openai"):
        self.text = text
        self.provider = provider
        self.calls = []

    def complete(self, request, route):
        self.calls.append((request, route))
        return AIProviderResponse(
            text=self.text,
            provider=self.provider,
            model=route.model,
            route=route.route,
            reason=route.reason,
            language=route.language,
            intent=route.intent,
            characters=len(self.text),
        )


class _ExplodingProvider:
    def complete(self, *_args, **_kwargs):
        raise AssertionError("provider should not be called")


class _BlankSarvamCompletions:
    def __call__(self, **_kwargs):
        return {"choices": [{"message": {"content": "   "}}]}


def _request(message: str, context_turns=None, reply_language=None) -> AIRequest:
    return AIRequest(
        user_id=1,
        message=message,
        reply_language=reply_language,
        channel="text",
        request_id="contextual-test",
        metadata={},
        context_turns=context_turns or [],
    )


def test_tanglish_tamil_followup_uses_previous_compiler_context():
    sarvam = _StaticProvider("கம்பைலர் என்பது code-ஐ computer புரியும் வடிவமாக மாற்றும் கருவி.", "sarvam")
    context = [
        {
            "user": "What is a compiler?",
            "assistant": "A compiler translates source code into machine-readable output.",
        }
    ]

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("Tamil la simple ah explain pannunga", context),
            existing_context={"sarvam_provider": sarvam, "openai_provider": _ExplodingProvider()},
        )

    assert response.provider == "sarvam"
    assert response.intent.startswith("contextual_")
    assert "கம்பைலர்" in response.text
    assert "Previous user question/topic: What is a compiler?" in sarvam.calls[0][0].message


def test_contextual_tamil_followup_without_history_asks_clarification_without_provider_call():
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("Tamil la simple ah explain pannunga"),
            existing_context={"sarvam_provider": _ExplodingProvider(), "openai_provider": _ExplodingProvider()},
        )
        event = session.exec(select(AIUsageEvent)).one()

    assert response.provider == "backend_tool"
    assert response.text == "எதை தமிழில் எளிமையாக விளக்க வேண்டும்?"
    assert response.raw["tool_action"] == "clarify_context"
    metadata = json.loads(event.metadata_json)
    assert metadata["context_turn_count"] == 0


def test_make_it_shorter_rewrites_previous_answer():
    openai = _StaticProvider("A compiler turns code into a runnable form.")
    long_answer = "A compiler reads source code, checks it, optimizes it, and emits machine code or bytecode."
    context = [{"user": "What is a compiler?", "assistant": long_answer}]

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("make it shorter", context, "en"),
            existing_context={"openai_provider": openai, "sarvam_provider": _ExplodingProvider()},
        )

    assert response.provider == "openai"
    assert response.intent == "contextual_rewrite"
    assert response.text == "A compiler turns code into a runnable form."
    assert "Previous assistant answer" in openai.calls[0][0].message


def test_sarvam_empty_contextual_response_falls_back_to_openai_and_keeps_tamil():
    client = type("Client", (), {"chat": type("Chat", (), {"completions": _BlankSarvamCompletions()})()})()
    sarvam = SarvamProvider(client=client)
    openai = _StaticProvider("கம்பைலர் code-ஐ இயந்திரம் புரியும் output ஆக மாற்றும்.", "openai")
    context = [{"user": "What is a compiler?", "assistant": "A compiler translates source code."}]

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("Tamil la simple ah explain pannunga", context),
            existing_context={"sarvam_provider": sarvam, "openai_provider": openai},
        )

    assert response.provider == "openai"
    assert response.language == "ta"
    assert "கம்பைலர்" in response.text
