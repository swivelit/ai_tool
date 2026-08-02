from app.ai.intent import classify_intent, normalize_voice_query_for_intent
from app.ai.router import AIProviderRouter
from app.ai.types import AIRequest


COLAB_CHATBOT_PROMPT = """Create a simple chatbot that runs in Google Colab.

Give me the code cell by cell in the correct order.

Requirements:

1. Do not use any external API or API key.
2. Use a small open-source language model that runs locally in Colab.
3. One cell must install the required libraries.
4. One cell must download and load the model.
5. One cell must create an SQLite database to store user and chatbot messages.
6. One cell must contain the chatbot response logic.
7. One cell must create a simple Gradio chat interface.
8. The chatbot must remember previous messages from the database.
9. The complete code must run from top to bottom without missing variables or functions.
10. Keep the code simple and suitable for a beginner."""


def test_backend_tool_intents_route_to_backend_tool():
    assert classify_intent("Create a reminder tomorrow morning").route == "backend_tool"
    assert classify_intent("What is my routine today?").route == "backend_tool"
    assert classify_intent("What do you know about my profile?").route == "backend_tool"
    assert classify_intent("Change reply language setting").route == "backend_tool"


def test_coding_and_complex_reasoning_are_rules_first():
    assert classify_intent("Debug this React Native architecture").intent == "coding"
    assert classify_intent("Give me a multi-step migration plan").intent == "complex_reasoning"


def test_technical_remember_requirement_is_a_coding_request():
    decision = classify_intent(COLAB_CHATBOT_PROMPT)

    assert decision.intent == "coding"
    assert decision.route == "coding"
    assert decision.reason == "coding_build_request"


def test_direct_remember_this_stays_a_note_command():
    for message in (
        "remember this: call the client tomorrow",
        "remember buy milk",
    ):
        decision = classify_intent(message)

        assert decision.intent == "note"
        assert decision.route == "backend_tool"


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


def test_emergency_symptoms_are_distinct_from_harmful_safety_requests():
    emergency = classify_intent(
        "A hypothetical person has sudden crushing chest pain, difficulty "
        "breathing, and pain spreading to the left arm. What should they do?"
    )
    harmful = classify_intent("I want to hurt myself")
    assert emergency.intent == "urgent_medical_emergency"
    assert emergency.route == "safety"
    assert harmful.intent == "unsafe_or_sensitive"
    assert harmful.route == "safety"


def test_abstract_preferences_and_plain_word_are_not_tool_intents():
    contradiction = """A product requirement says:

“The application must never store any user information, but it must permanently
remember each user’s preferences across all devices.”

Identify the contradiction, explain why it cannot be implemented literally, and
ask exactly three clarifying questions. Do not silently choose an interpretation."""
    story = """Write a micro-story of exactly 120 words.

Requirements:
- include the phrase “blue umbrella” exactly once
- the setting is a railway station
- no dialogue
- end with the word “home”
- do not include a title"""
    assert classify_intent(contradiction).intent == "general"
    assert classify_intent(story).intent == "general"


def test_explicit_settings_and_word_document_requests_still_use_tools():
    for message in (
        "Change my Swico reply language preference to Tamil.",
        "Update my preferences in settings.",
    ):
        assert classify_intent(message).intent == "settings"
    for message in (
        "Create a Microsoft Word file for these notes.",
        "Save these notes as a DOCX Word document.",
    ):
        assert classify_intent(message).intent == "document"


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


def test_wake_word_question_not_greeting_spitzola():
    message = "Hey Elli, can you tell me about Spitzola? I think it's a disease or something."

    decision = classify_intent(message)
    normalized = normalize_voice_query_for_intent(message)

    assert normalized["normalized"] == "tell me about Spitzola? I think it's a disease or something."
    assert normalized["stripped_wake_word"] is True
    assert decision.intent == "general"
    assert decision.route != "backend_tool"
    assert decision.metadata["intent_before_cleanup"] == "greeting"
    assert decision.metadata["intent_after_cleanup"] == "general"


def test_hey_elli_what_is_tamil_nadu_not_greeting():
    decision = classify_intent("Hey Elli, what is Tamil Nadu?")

    assert decision.intent == "general"
    assert decision.route != "backend_tool"


def test_hi_is_greeting():
    decision = classify_intent("Hi")

    assert decision.intent == "greeting"
    assert decision.route == "backend_tool"


def test_hi_elli_is_greeting():
    decision = classify_intent("Hi Elli")

    assert decision.intent == "greeting"
    assert decision.route == "backend_tool"


def test_hey_elli_do_you_know_about_fistula_not_greeting():
    decision = classify_intent("Hey Elli, do you know about fistula?")

    assert decision.intent == "general"
    assert decision.route != "backend_tool"


def test_normalized_message_metadata_is_recorded():
    route = AIProviderRouter().select_route(
        AIRequest(
            user_id=1,
            message="Hey Elli, what is Tamil Nadu?",
            reply_language="en",
            channel="voice",
            request_id="intent-test",
            metadata={},
        )
    )

    assert route.metadata["original_message"] == "Hey Elli, what is Tamil Nadu?"
    assert route.metadata["normalized_message"] == "what is Tamil Nadu?"
    assert route.metadata["stripped_wake_word"] is True
    assert route.metadata["stripped_prefix"] == "hey elli"
    assert route.metadata["intent_before_cleanup"] == "greeting"
    assert route.metadata["intent_after_cleanup"] == "general"
