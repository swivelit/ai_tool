from app.ai.intent import classify_intent


def test_backend_tool_intents_route_to_backend_tool():
    assert classify_intent("Create a reminder tomorrow morning").route == "backend_tool"
    assert classify_intent("What is my routine today?").route == "backend_tool"
    assert classify_intent("What do you know about my profile?").route == "backend_tool"
    assert classify_intent("Change reply language setting").route == "backend_tool"


def test_coding_and_complex_reasoning_are_rules_first():
    assert classify_intent("Debug this React Native architecture").intent == "coding"
    assert classify_intent("Give me a multi-step migration plan").intent == "complex_reasoning"


def test_live_data_is_not_general_chat():
    decision = classify_intent("latest IPL score today")

    assert decision.intent == "live_data"
    assert decision.route == "blocked_live_data"


def test_speech_translation_and_safety_intents():
    assert classify_intent("Translate this to Tamil").intent == "translation"
    assert classify_intent("read aloud this sentence").intent == "tts"
    assert classify_intent("transcribe this voice upload").intent == "stt"
    assert classify_intent("I have chest pain, what dosage should I take?").intent == "unsafe_or_sensitive"
