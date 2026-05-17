import json

from fastapi import HTTPException
from sqlmodel import select

from app.ai.orchestrator import run_text_turn
from app.ai.router import AIProviderRouter
from app.ai.types import AIProviderResponse, AIRequest
from app.database import SessionLocal
from app.models import AIUsageEvent


def _request(message: str, reply_language: str | None = "en", channel: str = "text", context_turns=None) -> AIRequest:
    return AIRequest(
        user_id=1,
        message=message,
        reply_language=reply_language,
        channel=channel,
        request_id="router-test",
        metadata={},
        context_turns=context_turns or [],
    )


def test_tamil_script_routes_to_sarvam_30b(monkeypatch):
    monkeypatch.setenv("SARVAM_CHAT_MODEL", "sarvam-30b")
    route = AIProviderRouter().select_route(_request("வணக்கம், நான் என்ன சாப்பிடலாம்?", None))

    assert route.provider == "sarvam"
    assert route.model == "sarvam-30b"


def test_tanglish_routes_to_sarvam_30b(monkeypatch):
    monkeypatch.setenv("SARVAM_CHAT_MODEL", "sarvam-30b")
    route = AIProviderRouter().select_route(_request("Tamil la explain pannunga", None))

    assert route.provider == "sarvam"
    assert route.model == "sarvam-30b"
    assert route.intent.startswith("contextual_")


def test_contextual_shortening_routes_to_openai_cheap_ladder(monkeypatch):
    monkeypatch.delenv("OPENAI_MODEL_CHEAP", raising=False)
    route = AIProviderRouter().select_route(_request("make it shorter", "en"))

    assert route.provider == "openai"
    assert route.intent == "contextual_rewrite"
    assert route.model == "gpt-5-nano"


def test_complex_indic_uses_sarvam_105b(monkeypatch):
    monkeypatch.setenv("SARVAM_CHAT_MODEL_REASONING", "sarvam-105b")
    route = AIProviderRouter().select_route(_request("Tamil la React Native architecture debug pannunga", None))

    assert route.provider == "sarvam"
    assert route.model == "sarvam-105b"


def test_english_simple_routes_to_gpt5_nano(monkeypatch):
    monkeypatch.delenv("OPENAI_MODEL_CHEAP", raising=False)
    route = AIProviderRouter().select_route(_request("What is a compiler?"))

    assert route.provider == "openai"
    assert route.model == "gpt-5-nano"
    assert route.model_candidates[:3] == ["gpt-5-nano", "gpt-4.1-nano", "gpt-4o-mini"]


def test_english_coding_routes_to_gpt5_mini(monkeypatch):
    monkeypatch.delenv("OPENAI_MODEL_REASONING", raising=False)
    route = AIProviderRouter().select_route(_request("Debug this React Native architecture"))

    assert route.provider == "openai"
    assert route.model == "gpt-5-mini"
    assert "gpt-4.1-mini" in route.model_candidates


def test_reminder_uses_backend_tool_without_model():
    route = AIProviderRouter().select_route(_request("Create a reminder tomorrow morning"))

    assert route.provider == "backend_tool"
    assert route.model is None


def test_live_data_is_blocked_when_web_search_disabled(monkeypatch):
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    route = AIProviderRouter().select_route(_request("latest IPL score today"))

    assert route.provider == "blocked"
    assert route.route == "live_data_disabled"


def test_voice_transcript_routes_like_text_after_stt(monkeypatch):
    monkeypatch.delenv("OPENAI_MODEL_CHEAP", raising=False)
    monkeypatch.delenv("OPENAI_MODEL_REASONING", raising=False)
    simple = AIProviderRouter().select_route(_request("What is a compiler?", channel="voice"))
    complex_route = AIProviderRouter().select_route(_request("Design this backend architecture", channel="voice"))
    tanglish = AIProviderRouter().select_route(_request("Tamil la explain pannunga", None, channel="voice"))

    assert simple.provider == "openai"
    assert simple.model == "gpt-5-nano"
    assert simple.needs_voice_output is True
    assert complex_route.provider == "openai"
    assert complex_route.model == "gpt-5-mini"
    assert tanglish.provider == "sarvam"


class _FailingProvider:
    def __init__(self, detail: str = "provider down"):
        self.calls = 0
        self.detail = detail

    def complete(self, request, route):
        self.calls += 1
        raise HTTPException(502, self.detail)


class _StaticProvider:
    def __init__(self, provider: str, model: str):
        self.provider = provider
        self.model = model
        self.calls = 0

    def complete(self, request, route):
        self.calls += 1
        return AIProviderResponse(
            text="fallback answer",
            provider=self.provider,
            model=route.model or self.model,
            route=route.route,
            reason=route.reason,
            language=route.language,
            intent=route.intent,
        )


def test_sarvam_failure_falls_back_once_to_openai_for_safe_indic(monkeypatch):
    monkeypatch.setenv("AI_MAX_PROVIDER_CALLS_PER_TURN_HARD", "2")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_PRIMARY", "gpt-5-nano")
    monkeypatch.setenv("OPENAI_MODEL_CHEAP_FALLBACKS", "gpt-4.1-nano,gpt-4o-mini")
    sarvam = _FailingProvider()
    openai = _StaticProvider("openai", "gpt-5-nano")
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request(
                "Tamil la explain pannunga",
                None,
                context_turns=[{"user": "What is a compiler?", "assistant": "A compiler translates code."}],
            ),
            existing_context={"sarvam_provider": sarvam, "openai_provider": openai},
        )
        event = session.exec(select(AIUsageEvent)).one()

    assert response.provider == "openai"
    assert response.model == "gpt-5-nano"
    assert sarvam.calls == 1
    assert openai.calls == 1
    metadata = json.loads(event.metadata_json)
    assert metadata["primary_provider"] == "sarvam"
    assert metadata["fallback_provider"] == "openai"
    assert metadata["fallback_attempted"] is True


def test_openai_failure_returns_controlled_unavailable_without_low_quality_fallback(monkeypatch):
    monkeypatch.setenv("AI_MAX_PROVIDER_CALLS_PER_TURN_HARD", "2")
    openai = _FailingProvider()
    sarvam = _StaticProvider("sarvam", "sarvam-30b")
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("What is a compiler?"),
            existing_context={"openai_provider": openai, "sarvam_provider": sarvam},
        )

    assert response.provider == "blocked"
    assert response.route == "openai_provider_unavailable"
    assert openai.calls == 1
    assert sarvam.calls == 0


def test_no_fallback_for_safety_block():
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("I want to harm myself"),
            existing_context={"global_cache_lookup": lambda *_args: {"answer": "unsafe cached answer"}},
        )

    assert response.provider == "blocked"
    assert response.route == "safety_block"


def test_no_fallback_for_live_data_disabled(monkeypatch):
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    with SessionLocal() as session:
        response = run_text_turn(session, _request("latest IPL score today"))

    assert response.provider == "blocked"
    assert response.route == "live_data_disabled"


def test_fallback_respects_hard_call_limit(monkeypatch):
    monkeypatch.setenv("AI_MAX_PROVIDER_CALLS_PER_TURN_HARD", "1")
    sarvam = _FailingProvider()
    openai = _StaticProvider("openai", "gpt-5-nano")
    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request(
                "Tamil la explain pannunga",
                None,
                context_turns=[{"user": "What is a compiler?", "assistant": "A compiler translates code."}],
            ),
            existing_context={"sarvam_provider": sarvam, "openai_provider": openai},
        )

    assert response.provider == "blocked"
    assert response.route == "sarvam_provider_unavailable"
    assert sarvam.calls == 1
    assert openai.calls == 0
