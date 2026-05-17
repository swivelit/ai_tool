from app.ai.language import detect_language, should_prefer_sarvam


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
    assert decision.prefer_provider == "sarvam"
