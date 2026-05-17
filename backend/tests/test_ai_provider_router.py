from app.ai.router import AIProviderRouter
from app.ai.types import AIRequest


def _request(message: str, reply_language: str | None = "en") -> AIRequest:
    return AIRequest(
        user_id=1,
        message=message,
        reply_language=reply_language,
        channel="text",
        request_id="router-test",
        metadata={},
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


def test_english_coding_routes_to_gpt5_mini(monkeypatch):
    monkeypatch.delenv("OPENAI_MODEL_REASONING", raising=False)
    route = AIProviderRouter().select_route(_request("Debug this React Native architecture"))

    assert route.provider == "openai"
    assert route.model == "gpt-5-mini"


def test_reminder_uses_backend_tool_without_model():
    route = AIProviderRouter().select_route(_request("Create a reminder tomorrow morning"))

    assert route.provider == "backend_tool"
    assert route.model is None


def test_live_data_is_blocked_when_web_search_disabled(monkeypatch):
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    route = AIProviderRouter().select_route(_request("latest IPL score today"))

    assert route.provider == "blocked"
    assert route.route == "live_data_disabled"
