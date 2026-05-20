from app.ai.language import detect_language, should_prefer_sarvam
from app.ai.router import AIProviderRouter
from app.ai.types import AIRequest


def test_tamil_script_prefers_sarvam():
    decision = detect_language("வணக்கம், நான் என்ன சாப்பிடலாம்?")

    assert decision.language == "ta"
    assert decision.is_indic is True
    assert decision.prefer_provider == "sarvam"
    assert should_prefer_sarvam("வணக்கம்") is True


def test_tanglish_prefers_sarvam():
    decision = detect_language("Tamil la explain pannunga")

    assert decision.language == "ta"
    assert decision.code_mixed is True
    assert decision.prefer_provider == "sarvam"


def test_english_coding_query_defaults_openai():
    decision = detect_language("Debug this React Native architecture")

    assert decision.language == "en"
    assert decision.is_indic is False
    assert decision.prefer_provider == "openai"


def test_reply_language_ta_prefers_sarvam_for_english_message():
    decision = detect_language("Explain photosynthesis", reply_language="ta")

    assert decision.language == "ta"
    assert decision.reply_language == "ta"
    assert decision.input_language == "en"
    assert decision.prefer_provider == "sarvam"


def test_reply_language_en_preserves_english_final_language_for_tamil_message():
    decision = detect_language("நாளைக்கு என்ன செய்யலாம்?", reply_language="en")

    assert decision.language == "en"
    assert decision.input_language == "ta"
    assert decision.reply_language == "en"
    assert decision.prefer_provider == "sarvam"
    assert decision.provider_preference == "sarvam"
    assert decision.reason == "reply_language_english_preserved"


def test_route_metadata_distinguishes_input_and_reply_language():
    route = AIProviderRouter().select_route(
        AIRequest(1, "நாளைக்கு என்ன செய்யலாம்?", "en", "voice", "language-test", {})
    )

    assert route.language == "en"
    assert route.metadata["input_language"] == "ta"
    assert route.metadata["reply_language"] == "en"
    assert route.metadata["provider_preference"] == "sarvam"


def test_expanded_tanglish_daily_command_prefers_sarvam():
    decision = detect_language("nethu business notes folder la save pannu")

    assert decision.language == "ta"
    assert decision.code_mixed is True
    assert decision.prefer_provider == "sarvam"


def test_tanglish_reply_language_aliases_prefer_indic_provider():
    for reply_language in ["tamil", "tanglish", "mixed"]:
        decision = detect_language("office meeting client lead save pannu", reply_language=reply_language)

        assert decision.is_indic is True
        assert decision.prefer_provider == "sarvam"
