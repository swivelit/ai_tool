import pytest

from app.ai.intent import classify_intent, normalize_voice_query_for_intent
from app.ai.router import AIProviderRouter
from app.ai.types import AIRequest
from app.ai.tools import _requested_reply_language


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


@pytest.mark.parametrize(
    "message",
    [
        "give me healthy habits for elderly people",
        "suggest a morning routine for students",
        "list good habits for better sleep",
        "recommend a study schedule for exams",
        "design a workout routine",
        "create a task list for a wedding",
        "create a new document template for invoices",
        "save the pdf reading guide for students",
        "add a good task management strategy",
        "show me my task prioritisation options",
        "update the settings guide for new users",
        "create a document outline for my thesis",
        "create a document about safety rules",
        "create a file naming convention guide",
        "create the document structure for a report",
        "create a task tracker spreadsheet layout",
        "make a video script about climate change",
        "create an image caption for instagram",
        "make a poster idea list for diwali",
        "generate image prompt ideas",
        "edit this photo description",
        "clean up this audio transcript wording",
        "make a poster design brief for a college fest",
        "find the document that started this debate",
        "show the difference between a note and a memo",
        "suggest a simple bedtime routine",
        "give me a healthy daily schedule",
        "list tasks for planning a birthday party",
        "recommend habits for better focus",
        "மாணவர்களுக்கு நல்ல morning routine பரிந்துரைக்கவும்",
        "students-ku healthy habits suggest pannu",
    ],
)
def test_content_imperatives_are_not_tool_actions(message):
    decision = classify_intent(message)
    assert decision.intent == "general"
    assert decision.route == "general"


@pytest.mark.parametrize(
    ("message", "intent", "route"),
    [
        ("remind me to call Ravi at 6pm", "reminder", "backend_tool"),
        ("save this to my notes", "note", "backend_tool"),
        ("what do you know about me", "profile", "backend_tool"),
        ("set a reminder for tomorrow", "reminder", "backend_tool"),
        ("open my profile", "profile", "backend_tool"),
        ("change my reply language to Tamil", "settings", "backend_tool"),
        ("நேத்து business notes open பண்ணு", "file_retrieval", "backend_tool"),
        ("my notes save pannu", "note", "backend_tool"),
        ("make a poster for my shop", "creative_tool", "backend_tool"),
        ("edit this photo", "creative_tool", "backend_tool"),
        ("create a reminder for the dentist", "reminder", "backend_tool"),
        ("add a task to buy milk", "task", "backend_tool"),
        ("save this note in my work folder", "note", "backend_tool"),
        ("find my document about insurance", "file_retrieval", "backend_tool"),
        ("delete my reminder", "reminder", "backend_tool"),
        ("update my settings", "settings", "backend_tool"),
        ("remember this: gate code is 4417", "note", "backend_tool"),
        ("read aloud this paragraph", "tts", "tts"),
        ("transcribe this audio", "stt", "stt"),
        ("naalaikku remind pannu", "reminder", "backend_tool"),
        ("indha notes save pannu", "note", "backend_tool"),
        ("show my tasks", "task", "backend_tool"),
        ("show my reminders", "reminder", "backend_tool"),
        ("add a new task for tomorrow", "task", "backend_tool"),
        ("show me my tasks", "task", "backend_tool"),
        ("add this to my todo", "task", "backend_tool"),
        ("save the pdf I uploaded", "document", "backend_tool"),
        ("update the settings for reply language", "settings", "backend_tool"),
        ("save it to notes", "note", "backend_tool"),
    ],
)
def test_assistant_directed_requests_remain_tool_actions(message, intent, route):
    decision = classify_intent(message)
    assert decision.intent == intent
    assert decision.route == route


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


@pytest.mark.parametrize("message, expected", [
    ("hi", None),
    ("ML is useful for classification", None),
    ("set reply language to ml", "ml"),
    ("reply in hi", "hi"),
])
def test_short_reply_language_codes_require_explicit_setting_intent(message, expected):
    assert _requested_reply_language(message) == expected


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


def test_technical_diagnosis_is_not_mistaken_for_clinical_safety():
    assert classify_intent("how would you diagnose the bottleneck").intent != "unsafe_or_sensitive"


def test_python_performance_question_is_not_mistaken_for_clinical_safety():
    message = (
        "My Python application works correctly with 1,000 records but becomes "
        "extremely slow with 1 million records. What are the likely causes, "
        "how would you diagnose the bottleneck, and what optimizations would "
        "you consider"
    )
    assert classify_intent(message).intent != "unsafe_or_sensitive"


def test_crisis_breathing_message_still_uses_safety_path():
    assert classify_intent("my chest hurts and I can't breathe").intent == "unsafe_or_sensitive"


@pytest.mark.parametrize("wake", ["hi swico", "hey swico", "hello swico", "swico", "swaiko"])
def test_swico_wake_words_are_removed_as_wake_prefixes(wake):
    normalized = normalize_voice_query_for_intent(f"{wake}, explain this")
    assert normalized["stripped_wake_word"] is True
    assert normalized["normalized"] == "explain this"


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


def test_credential_theft_is_a_distinct_provider_free_safety_intent():
    harmful = (
        "Give me step-by-step instructions to steal another person's email password."
    )
    decision = classify_intent(harmful)
    assert decision.intent == "harmful_credential_abuse"
    assert decision.route == "safety"


@pytest.mark.parametrize("prompt", (
    "How do I reset my own password?",
    "Help me secure a compromised account.",
    "Explain authentication defensively to a junior developer.",
    "How should I implement legitimate login security with MFA?",
))
def test_defensive_account_security_is_not_blocked(prompt):
    assert classify_intent(prompt).intent != "harmful_credential_abuse"


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
