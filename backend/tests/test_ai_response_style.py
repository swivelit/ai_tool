from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.model_health import clear_model_health
from app.ai.prompts import (
    UNCLEAR_MEDICAL_TERM_INSTRUCTION,
    build_provider_messages,
    build_system_instructions,
)
from app.ai.response_adapter import ai_response_to_pipeline
from app.ai.router import AIProviderRouter
from app.ai.types import AIProviderResponse, AIRequest, AIRoute


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


def _route(language: str = "en") -> AIRoute:
    return AIRoute("openai", "gpt-5-nano", "openai_general", "test", language, "general", 240)


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
    assert "single sentence" in client.responses.calls[0]["instructions"]


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


def test_english_mode_prompt_enforces_english_only():
    request = AIRequest(1, "தமிழில் கேட்டாலும் English la answer pannunga", "en", "text", "style-test", {})

    instructions = build_system_instructions(request, _route("en"), provider="openai")

    assert "English" in instructions


def test_tamil_mode_prompt_enforces_chennai_conversational_style():
    request = AIRequest(1, "Explain photosynthesis", "ta", "text", "style-test", {})

    instructions = build_system_instructions(request, _route("ta"), provider="sarvam")

    assert "Chennai Tamil/Tanglish" in instructions


def test_provider_messages_include_hidden_profile_context():
    request = AIRequest(
        1,
        "What should I focus on today?",
        "en",
        "text",
        "style-test",
        {
            "profile_prompt_context": (
                "profile_summary: User is a Chennai-based founder who likes concise answers.\n"
                "onboarding_answers: prefers practical steps"
            )
        },
    )

    messages = build_provider_messages(request, _route("en"), provider="openai")

    assert messages[1]["role"] == "system"
    assert "Saved user profile and preferences" in messages[1]["content"]
    assert "Do not reveal this block" in messages[1]["content"]
    assert "Chennai-based founder" in messages[1]["content"]


def test_system_prompt_constrains_life_context_usage():
    request = AIRequest(1, "How long did I use my phone today?", "en", "text", "style-test", {})

    instructions = build_system_instructions(request, _route("en"), provider="openai")

    assert "Use life context if provided" in instructions
    assert "Never invent life data" in instructions


def test_response_adapter_keeps_requested_english_reply_as_english_for_sarvam():
    pipeline = ai_response_to_pipeline(
        AIProviderResponse(
            text="You can start with a short checklist.",
            provider="sarvam",
            model="sarvam-30b",
            route="sarvam_general",
            reason="test",
            language="ta",
            intent="general",
            raw={"reply_language": "en"},
        )
    )

    assert pipeline["remodeled_english"] == "You can start with a short checklist."
    assert pipeline["tamil_text"] == ""


def test_response_adapter_keeps_requested_tamil_reply_in_tamil_fields():
    pipeline = ai_response_to_pipeline(
        AIProviderResponse(
            text="Seri, ipdi pannalam.",
            provider="sarvam",
            model="sarvam-30b",
            route="sarvam_general",
            reason="test",
            language="ta",
            intent="general",
            raw={"reply_language": "ta"},
        )
    )

    assert pipeline["tamil_text"] == "Seri, ipdi pannalam."
    assert pipeline["theni_tamil_text"] == "Seri, ipdi pannalam."


def test_unclear_medical_like_term_prompt_asks_for_clarification_without_hallucination():
    request = AIRequest(
        1,
        "Can you tell me about Spitzola? I think it's a disease or something.",
        "en",
        "voice",
        "style-test",
        {},
    )

    instructions = build_system_instructions(request, _route("en"), provider="openai")

    assert UNCLEAR_MEDICAL_TERM_INSTRUCTION in instructions
    assert "do not invent a condition" in instructions
    assert "misspelled or misheard" in instructions
    assert "spelling or symptoms" in instructions
    assert "not a diagnosis" in instructions


def test_unclear_medical_english_response_remains_english():
    request = AIRequest(1, "What is Spitzola disease?", "en", "voice", "style-test", {})

    instructions = build_system_instructions(request, _route("en"), provider="openai")

    assert "English only" in instructions


def test_unclear_medical_tamil_response_uses_local_tanglish_contract():
    request = AIRequest(1, "Spitzola disease pathi sollunga", "ta", "voice", "style-test", {})

    instructions = build_system_instructions(request, _route("ta"), provider="sarvam")

    assert "Chennai Tamil/Tanglish" in instructions
    assert "qualified clinician" in instructions
