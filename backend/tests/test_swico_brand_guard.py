from __future__ import annotations

import json
import re
from uuid import uuid4

import pytest
from sqlmodel import select

from app.ai.prompts import APP_CONTEXT_PROMPT, build_system_instructions
from app.ai.types import AIProviderResponse, AIRequest, AIRoute
from app.database import SessionLocal
from app.models import UsageCharge, WebChatMessage
from app.web_api.swico_brand import (
    SWICO_PUBLIC_PROFILE,
    SWICO_PUBLIC_PROFILE_VERSION,
    SwicoBrandSubintent,
    classify_swico_brand_query,
    public_swico_response_templates,
    swico_brand_response,
    validate_swico_public_response,
)
from app.web_api.deterministic_answers import try_deterministic_answer
from app.web_api.turn_optimizer import optimize_web_turn
from tests.conftest import auth_headers, create_test_user
from tests.test_web_chat_api import _sse_events, _stream_text


def _request_id(index: int) -> str:
    return f"91000000-0000-4000-8000-{index:012d}"


def _post(client, message: str, index: int, **extra):
    return client.post(
        "/api/web/chat/stream",
        headers=auth_headers("brand-user", "brand-user@example.com"),
        json={"request_id": _request_id(index), "message": message, **extra},
    )


def _metadata(request_id: str) -> dict:
    with SessionLocal() as session:
        row = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "assistant",
        )).one()
        return json.loads(row.metadata_json)


@pytest.mark.parametrize(
    ("question", "expected", "subintent"),
    [
        ("What is Swico?", "flagship product", "about"),
        ("Who created Swico?", "CEO Jeyanth", "creator"),
        ("Which company developed Swico?", "Swivel Technologies", "company"),
        ("Who are you?", "I’m Swico", "identity"),
        ("What can Swico do?", "document analysis", "capabilities"),
        ("How does Swico reduce tokens?", "selective context", "token_efficiency"),
        ("What model powers Swico?", "intelligent routing", "model_or_provider"),
        ("Does Swico use Sarvam AI?", "advanced large language models", "model_or_provider"),
        ("Compare Swico with ChatGPT", "practical and affordable", "comparison"),
    ],
)
def test_explicit_brand_questions_are_bounded_deterministic(
    question, expected, subintent
):
    result = optimize_web_turn(question)
    assert result.optimization_route == "deterministic_swico_brand"
    assert result.local_intent == "swico_brand"
    assert result.cache_eligible is False
    assert result.brand_subintent == subintent
    answer = swico_brand_response(
        result.brand_subintent, reply_language="en", message=question
    )
    assert expected in answer


@pytest.mark.parametrize(
    "question",
    [
        "Are you ChatGPT?",
        "Are you Sarvam AI?",
        "Does Swico use Sarvam AI?",
        "What model powers Swico?",
        "Compare Swico with ChatGPT",
    ],
)
def test_brand_answers_never_repeat_restricted_input_terms(question):
    result = optimize_web_turn(question)
    assert result.local_intent == "swico_brand"
    answer = swico_brand_response(
        result.brand_subintent, reply_language="en", message=question
    ).casefold()
    restricted = ("chat" + "gpt", "open" + "ai", "sar" + "vam", "gpt-")
    assert all(term not in answer for term in restricted)
    assert "swico" in answer


def test_unknown_swivel_founder_fact_is_not_invented():
    result = optimize_web_turn("Who is the founder of Swivel Technologies?")
    assert result.brand_subintent == "ownership_unknown"
    answer = swico_brand_response(
        result.brand_subintent, reply_language="en"
    )
    assert "does not provide a separate founder or legal ownership statement" in answer
    assert "CEO Jeyanth" in answer


def test_tamil_creator_question_has_faithful_deterministic_answer():
    question = "ஸ்விகோவை யார் உருவாக்கினார்?"
    result = optimize_web_turn(question, reply_language="ta")
    answer = swico_brand_response(
        result.brand_subintent, reply_language="ta", message=question
    )
    assert result.brand_subintent == "creator"
    assert "CEO Jeyanth" in answer
    assert "Swivel Technologies" in answer
    assert "தலைமையில்" in answer


@pytest.mark.parametrize(
    ("question", "language"),
    [
        (
            "What is Swico, which company develops it, and who led its creation?",
            "en",
        ),
        (
            "Swico என்றால் என்ன, அதை எந்த நிறுவனம் உருவாக்குகிறது, "
            "அதன் உருவாக்கத்தை யார் வழிநடத்தினார்?",
            "ta",
        ),
    ],
)
def test_compound_public_profile_questions_include_all_approved_facts(
    question, language,
):
    optimized = optimize_web_turn(question, reply_language=language)
    answer = swico_brand_response(
        optimized.brand_subintent,
        reply_language=language,
        message=question,
    )
    assert optimized.optimization_route == "deterministic_swico_brand"
    assert optimized.brand_subintent == "public_profile"
    assert all(value in answer for value in (
        "Swico", "Swivel Technologies", "CEO Jeyanth",
    ))


def test_compound_public_profile_web_turn_is_provider_free(client, monkeypatch):
    create_test_user("brand-user", "brand-user@example.com")
    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation",
        lambda *args, **kwargs: pytest.fail("compound brand route must not reserve"),
    )
    response = _post(
        client,
        "What is Swico, which company develops it, and who led its creation?",
        11,
    )
    assert response.status_code == 200
    assert all(value in _stream_text(response) for value in (
        "Swico", "Swivel Technologies", "CEO Jeyanth",
    ))
    assert _metadata(_request_id(11))["provider_attempts"] == 0


def test_validator_falls_back_without_llm_for_configured_model(monkeypatch):
    monkeypatch.setenv("SWICO_LITE_MODEL_PRIMARY", "private-upstream-77")
    answer = validate_swico_public_response("Swico uses private-upstream-77.")
    assert answer == "I’m Swico, an AI-powered assistant developed by Swivel Technologies."
    assert "private-upstream-77" not in answer


def test_brand_web_turn_zero_provider_cache_and_wallet(client, monkeypatch):
    create_test_user("brand-user", "brand-user@example.com")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *args, **kwargs: pytest.fail("brand route must precede approved cache"),
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation",
        lambda *args, **kwargs: pytest.fail("brand route must not reserve"),
    )
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        lambda *args, **kwargs: pytest.fail("brand route must not call a provider"),
    )
    monkeypatch.setattr(
        "app.ai.providers.sarvam_provider.SarvamProvider.stream_complete",
        lambda *args, **kwargs: pytest.fail("brand route must not call a provider"),
    )

    response = _post(client, "Who created Swico?", 1)
    assert response.status_code == 200
    assert "CEO Jeyanth" in _stream_text(response)
    assert _sse_events(response, "delta")
    assert _sse_events(response, "done")

    with SessionLocal() as session:
        assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == _request_id(1),
            WebChatMessage.role == "assistant",
        )).one()
        assert assistant.provider == "backend_tool"
        assert assistant.input_tokens == assistant.output_tokens == 0
        assert assistant.charge_micros == 0
        assert session.exec(select(UsageCharge)).all() == []
    metadata = _metadata(_request_id(1))
    assert metadata["optimization_route"] == "deterministic_swico_brand"
    assert metadata["topic"] == metadata["brand_topic"] == "swico"
    assert metadata["brand_subintent"] == "creator"
    assert metadata["brand_profile_version"] == SWICO_PUBLIC_PROFILE_VERSION
    assert metadata["provider_attempts"] == 0
    assert metadata["provider_calls_with_usage"] == 0
    assert metadata["reserved_micros"] == 0
    assert metadata["charged_micros"] == 0
    assert metadata["cache_hit"] is False


def test_brand_query_ignores_old_restricted_approved_cache_answer(client, monkeypatch):
    create_test_user("brand-user", "brand-user@example.com")
    stale = AIProviderResponse(
        text="Old OpenAI answer", provider="cache", model=None,
        route="global_knowledge_cache", reason="old", language="en", intent="general",
    )
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *args, **kwargs: pytest.fail(
            f"brand route read stale cache: {stale.text}"
        ),
    )
    response = _post(client, "What is Swico?", 2)
    assert response.status_code == 200
    text = _stream_text(response)
    assert "Swico" in text
    assert "OpenAI" not in text


def test_contextual_brand_followup_uses_only_previous_safe_topic(client):
    create_test_user("brand-user", "brand-user@example.com")
    first = _post(client, "Tell me about Swico", 3)
    thread_id = _sse_events(first, "thread")[0]["thread_id"]
    second = _post(client, "Who created it?", 4, thread_id=thread_id)
    assert second.status_code == 200
    assert "CEO Jeyanth" in _stream_text(second)
    metadata = _metadata(_request_id(4))
    assert metadata["topic"] == "swico"
    assert metadata["brand_subintent"] == "creator"


def test_non_swico_previous_topic_does_not_activate_followup(client):
    create_test_user("brand-user", "brand-user@example.com")
    first = _post(client, "hello", 5)
    thread_id = _sse_events(first, "thread")[0]["thread_id"]
    second = _post(client, "Who created it?", 6, thread_id=thread_id)
    assert second.status_code == 402
    with SessionLocal() as session:
        assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == _request_id(6),
            WebChatMessage.role == "assistant",
        )).first()
        assert assistant is None


def test_brand_guard_applies_to_voice_input_mode(client):
    create_test_user("brand-user", "brand-user@example.com")
    voice_turn_id = str(uuid4())
    response = _post(
        client, "Who are you?", 7,
        input_mode="voice", voice_turn_id=voice_turn_id,
    )
    assert response.status_code == 200
    assert "I’m Swico" in _stream_text(response)
    done = _sse_events(response, "done")[0]
    assert done["input_mode"] == "voice"
    assert done["voice_turn_id"] == voice_turn_id
    assert _metadata(_request_id(7))["provider_attempts"] == 0


def test_brand_idempotent_replay_creates_no_second_message_or_charge(client):
    create_test_user("brand-user", "brand-user@example.com")
    first = _post(client, "What is Swico?", 8)
    second = _post(client, "What is Swico?", 8)
    assert first.status_code == second.status_code == 200
    assert _stream_text(first) == _stream_text(second)
    with SessionLocal() as session:
        messages = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == _request_id(8)
        )).all()
        charges = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == _request_id(8)
        )).all()
        assert len(messages) == 2
        assert charges == []


def test_disabled_brand_guard_follows_previous_cache_path(client, monkeypatch):
    create_test_user("brand-user", "brand-user@example.com")
    monkeypatch.setenv("WEB_SWICO_BRAND_GUARD_ENABLED", "false")
    cached = AIProviderResponse(
        text="Previous path", provider="cache", model=None,
        route="global_knowledge_cache", reason="hit", language="en", intent="general",
        raw={"cache_hit": True, "cache_hit_source": "test"},
    )
    calls = {"cache": 0}

    def cache(*args, **kwargs):
        calls["cache"] += 1
        return cached

    monkeypatch.setattr("app.web_api.chat_service._cache_response", cache)
    response = _post(client, "What is Swico?", 9)
    assert response.status_code == 200
    assert _stream_text(response).strip() == "Previous path"
    assert calls["cache"] == 1
    assert _metadata(_request_id(9))["optimization_route"] == "approved_cache_hit"


@pytest.mark.parametrize(
    "question",
    [
        "Who created Python?",
        "What is a software model?",
        "Explain agent architecture generally",
        "Who developed Linux?",
    ],
)
def test_ordinary_questions_are_not_brand_classified(question):
    assert classify_swico_brand_query(question) is None
    assert optimize_web_turn(question).local_intent != "swico_brand"


@pytest.mark.parametrize(
    "question",
    [
        "Hi SWICO, I'm studying in 10th standard. Can you explain photosynthesis in a simple way with an example?",
        "Hi SWICO, can you explain the difference between frontend and backend development?",
        "Hi SWICO, I need a final-year project idea based on artificial intelligence. Can you suggest a few practical ideas",
        "Hi SWICO, imagine a city wants to reduce plastic waste by 50% in five years. What practical steps should the city take, and why would each step help",
        "Hi SWICO, my Python application works correctly with 1,000 records but becomes extremely slow with 1 million records. What are the likely causes, how would you diagnose the bottleneck, and what optimizations would you consider",
        "hi swico ,what is AI",
    ],
)
def test_vocative_product_address_does_not_hijack_ordinary_questions(question):
    assert classify_swico_brand_query(question) is None


@pytest.mark.parametrize(
    "question",
    [
        "What is Swico?",
        "Hi Swico, who are you?",
        "Who created you?",
        "Tell me about Swico",
        "Which company developed you?",
        "What can Swico do?",
        "Who made Swico?",
        "How does Swico work?",
        "Is Swico secure?",
        "What model do you use?",
    ],
)
def test_aboutness_brand_questions_still_use_the_brand_route(question):
    assert classify_swico_brand_query(question) is not None


def test_long_vocative_question_is_not_given_the_simple_brand_budget():
    question = (
        "Hi SWICO, my Python application works correctly with 1,000 records but becomes extremely slow "
        "with 1 million records. What are the likely causes, how would you diagnose the bottleneck, "
        "and what optimizations would you consider"
    )
    optimized = optimize_web_turn(question)
    assert optimized.answer_class != "simple"
    assert optimized.optimization_route != "deterministic_swico_brand"


def test_saved_reply_language_is_authoritative_for_brand_reply():
    tamil = swico_brand_response(
        SwicoBrandSubintent.ABOUT, reply_language="ta", message="What is Swico?"
    )
    english = swico_brand_response(
        SwicoBrandSubintent.ABOUT, reply_language="en", message="ஸ்விகோ என்றால் என்ன?"
    )
    tanglish = swico_brand_response(
        SwicoBrandSubintent.ABOUT,
        reply_language="tanglish",
        message="Recharge eppadi panna mudiyum?",
    )
    assert "Swivel Technologies உருவாக்கிய" in tamil
    assert "Swico is" in english
    assert "உருவாக்கிய" not in english
    assert "Swivel Technologies uruvaakkiya" in tanglish


@pytest.mark.parametrize(
    ("message", "expected_language", "unexpected"),
    [
        ("What is Swico?", "ta", "Swico is"),
        ("Does Swico support Tanglish?", "en", "உருவாக்கிய"),
        ("Recharge eppadi panna mudiyum?", "en", "pannunga"),
    ],
)
def test_deterministic_language_prefers_saved_profile_over_input_style(
    message, expected_language, unexpected,
):
    answer = swico_brand_response(
        SwicoBrandSubintent.ABOUT,
        reply_language=expected_language,
        message=message,
    )
    if expected_language == "ta":
        assert re.search(r"[\u0b80-\u0bff]", answer)
    else:
        assert unexpected not in answer


def test_saved_english_preference_keeps_tanglish_billing_input_english():
    with SessionLocal() as session:
        response = try_deterministic_answer(
            session,
            user_id=1,
            message="Credits vaanga eppadi?",
            reply_language="en",
            request_id="language-authority-billing",
        )
    assert response is not None
    assert "Open **Add credits**" in response.text
    assert "pannunga" not in response.text


@pytest.mark.parametrize(
    "followup",
    [
        "Who made it?",
        "Who developed it?",
        "Which company?",
        "What company made it?",
        "What can it do?",
        "How does it work?",
        "What model does it use?",
        "Is it secure?",
        "Does it support Tamil?",
        "Can it analyse documents?",
        "What about billing?",
        "Tell me more.",
        "Who is the CEO?",
        "What is the architecture?",
    ],
)
def test_bounded_contextual_followup_phrases(followup):
    match = classify_swico_brand_query(followup, previous_topic="swico")
    assert match is not None and match.contextual is True
    assert classify_swico_brand_query(followup, previous_topic="other") is None


def test_public_prompt_and_templates_regression_scan():
    request = AIRequest(
        1, "Design the backend architecture for my app", "en", "text", "scan",
        {"client_surface": "web"},
    )
    route = AIRoute("openai", "internal", "test", "test", "en", "complex_reasoning", 100)
    public_texts = [
        APP_CONTEXT_PROMPT,
        json.dumps(SWICO_PUBLIC_PROFILE.__dict__, ensure_ascii=False),
        build_system_instructions(request, route, provider="openai"),
        build_system_instructions(request, route, provider="sarvam"),
        *public_swico_response_templates(),
    ]
    restricted = ("chat" + "gpt", "open" + "ai", "sar" + "vam", "gpt-")
    for public_text in public_texts:
        lowered = public_text.casefold()
        assert all(term not in lowered for term in restricted)


def test_brand_log_metadata_contains_no_raw_question_or_profile(caplog, client):
    create_test_user("brand-user", "brand-user@example.com")
    marker = "raw-brand-question-marker"
    with caplog.at_level("INFO"):
        response = _post(client, f"What is Swico? {marker}", 10)
    assert response.status_code == 200
    records = [record for record in caplog.records if record.message == "web_turn_optimized"]
    assert records
    serialized = json.dumps(records[-1].__dict__, default=str)
    assert marker not in serialized
    assert "SWICO_PUBLIC_PROFILE" not in serialized


def test_all_brand_templates_validate_without_restricted_terms():
    for subintent in SwicoBrandSubintent:
        for language in ("en", "ta", "tanglish", "hi", "bn", "te", "kn", "ml", "mr", "gu", "pa", "od"):
            text = swico_brand_response(subintent, reply_language=language)
            assert text == validate_swico_public_response(text)


@pytest.mark.parametrize("question", [
    "Swico क्या है?", "Swico কী?", "Swico అంటే ఏమిటి?", "Swico ಎಂದರೇನು?",
    "Swico എന്താണ്?", "Swico म्हणजे काय?", "Swico શું છે?", "Swico ਕੀ ਹੈ?",
    "Swico କଣ?",
])
def test_native_language_swico_identity_questions_use_deterministic_brand_route(question):
    match = classify_swico_brand_query(question)
    assert match is not None
    assert match.subintent == SwicoBrandSubintent.ABOUT
