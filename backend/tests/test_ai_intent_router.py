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


def test_today_now_current_are_not_live_data_without_domain():
    assert classify_intent("What should I eat today?").intent == "general"
    assert classify_intent("What should I do now?").intent == "general"
    assert classify_intent("Plan my day today").intent in {"general", "complex_reasoning"}
    assert classify_intent("Plan my day today").intent != "live_data"


def test_live_data_requires_live_domain():
    assert classify_intent("latest IPL score today").intent == "live_data"
    assert classify_intent("What is the current stock price of Apple?").intent == "live_data"
    assert classify_intent("What is the weather tomorrow?").intent == "weather"


def test_speech_translation_and_safety_intents():
    assert classify_intent("Translate this to Tamil").intent == "translation"
    assert classify_intent("read aloud this sentence").intent == "tts"
    assert classify_intent("transcribe this voice upload").intent == "stt"
    assert classify_intent("I have chest pain, what dosage should I take?").intent == "unsafe_or_sensitive"


def test_tamil_tanglish_document_intents_route_to_backend_tool():
    cases = [
        "இந்த points PDF ஆக்கி work folder ல வை",
        "meeting notes Word document ஆக்கி save பண்ணு",
        "sales data Excel sheet பண்ணு",
        "project update PPT ஆக்கி வை",
    ]

    for message in cases:
        decision = classify_intent(message)
        assert decision.intent == "document"
        assert decision.route == "backend_tool"


def test_tamil_tanglish_file_retrieval_routes_to_backend_tool():
    cases = [
        "நேத்து சொன்ன business notes open பண்ணு",
        "yesterday work pdf open pannu",
        "home bill file show பண்ணு",
    ]

    for message in cases:
        decision = classify_intent(message)
        assert decision.intent == "file_retrieval"
        assert decision.route == "backend_tool"


def test_tamil_tanglish_reminder_note_task_routes_to_backend_tool():
    cases = [
        ("அம்மா medicine நாளைக்கு காலை remind பண்ணு", "reminder"),
        ("EB bill tomorrow reminder save pannu", "reminder"),
        ("client follow up note save பண்ணு", "note"),
        ("office meeting task add பண்ணு", "task"),
    ]

    for message, expected_intent in cases:
        decision = classify_intent(message)
        assert decision.intent == expected_intent
        assert decision.route == "backend_tool"
