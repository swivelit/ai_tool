from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from sqlmodel import select

from app.ai.prompts import (
    UNCLEAR_MEDICAL_TERM_INSTRUCTION, build_provider_messages,
    build_system_instructions, serialize_provider_messages,
)
from app.ai.providers.openai_provider import OpenAIProvider
from app.ai.types import AIProviderResponse, AIRequest, AIRoute
from app.billing.pricing import estimate_tokens
from app.database import SessionLocal
from app.models import UsageCharge, WebChatMessage, WebChatThread
from app.openai_model_router import OpenAIModelRouter
from app.profile_context import build_profile_prompt_context
from app.web_api.attachment_context import select_attachment_context
from app.web_api.chat_service import prepare_web_turn
from app.web_api.turn_optimizer import optimize_web_turn
from app.web_api.upload_store import EphemeralUpload, ExtractedChunk, utc_iso
from tests.conftest import auth_headers, create_test_user
from tests.test_web_chat_api import _fund


def _route(intent: str = "general", model: str = "gpt-5.4-mini") -> AIRoute:
    return AIRoute(
        "openai", model, f"openai_{intent}", "test", "en", intent, 320,
        model_candidates=[model], provider_endpoint_candidates=["chat_completions"],
    )


def _history(count: int = 6, width: int = 80) -> list[dict[str, str]]:
    return [
        {"user": f"question {index} " + "u" * width, "assistant": f"answer {index} " + "a" * width}
        for index in range(count)
    ]


def test_standalone_sends_zero_context_and_contextual_caps(monkeypatch):
    standalone = optimize_web_turn("What is photosynthesis?", context_turns=_history())
    assert standalone.is_contextual_followup is False
    assert standalone.selected_context_turns == []
    assert standalone.context_chars_sent == 0

    monkeypatch.setenv("WEB_CONTEXT_MAX_TURNS", "2")
    monkeypatch.setenv("WEB_CONTEXT_MAX_CHARS", "900")
    followup = optimize_web_turn("Make that shorter", context_turns=_history(width=500))
    assert followup.is_contextual_followup is True
    assert len(followup.selected_context_turns) <= 2
    assert len(followup.formatted_context) == followup.context_chars_sent <= 900
    assert "question 5" in followup.formatted_context


def test_complete_software_developer_roadmap_is_long_form(monkeypatch):
    monkeypatch.setenv("WEB_LONG_FORM_MAX_OUTPUT_TOKENS", "1400")
    monkeypatch.setenv("OPENAI_MAX_OUTPUT_TOKENS_HARD", "1800")
    result = optimize_web_turn(
        "I want to become a software developer. Give me a complete roadmap"
    )
    assert result.answer_class == "long_form"
    assert result.max_output_tokens == 1400
    assert result.max_output_tokens > optimize_web_turn("What is Python?").max_output_tokens


def test_compact_profile_is_selective_private_and_bounded(monkeypatch):
    monkeypatch.setenv("WEB_PROFILE_PROMPT_MAX_CHARS", "500")
    profile = {
        "user": {"name": "Private", "place": "Chennai", "timezone": "Asia/Kolkata", "assistant_name": "Elli"},
        "communication_tone": "friendly" * 80,
        "answer_length": "short",
        "age_group": "13_17",
        "onboarding_answers": {"occupation": "student", "secret_goal": "private"},
        "profile_summary": "private summary",
    }
    result = optimize_web_turn("What is AI?", profile_context=profile, reply_language="en")
    assert result.profile_chars_sent <= 500
    assert "student" not in result.compact_profile_prompt
    assert "private summary" not in result.compact_profile_prompt
    assert "minor_safety" in result.compact_profile_prompt


@pytest.mark.parametrize(
    "question",
    ["What is photosynthesis?", "Explain blockchain.", "Tell me about cricket.", "What is democracy?"],
)
def test_generic_factual_questions_do_not_receive_medical_block(question):
    instructions = build_system_instructions(
        AIRequest(1, question, "en", "text", "medical-regression", {"client_surface": "web"}),
        _route(), provider="openai",
    )
    assert UNCLEAR_MEDICAL_TERM_INSTRUCTION not in instructions


def test_explicit_unclear_medical_context_remains_guarded():
    question = "My doctor called this an unclear Xylora medical condition. What is it?"
    instructions = build_system_instructions(
        AIRequest(1, question, "en", "text", "medical-positive", {"client_surface": "web"}),
        _route(), provider="openai",
    )
    assert UNCLEAR_MEDICAL_TERM_INSTRUCTION in instructions


def test_medical_regression_prompt_estimate_is_close_to_peer_fact():
    def prompt_tokens(question: str) -> int:
        request = AIRequest(1, question, "en", "text", "estimate", {"client_surface": "web"})
        return estimate_tokens(serialize_provider_messages(build_provider_messages(request, _route(), provider="openai")))

    photosynthesis = prompt_tokens("What is photosynthesis?")
    democracy = prompt_tokens("What is democracy?")
    assert abs(photosynthesis - democracy) < 30


def test_attachment_retrieval_is_ranked_deduplicated_and_capped(monkeypatch):
    monkeypatch.setenv("WEB_ATTACHMENT_PROMPT_MAX_CHARS", "8000")
    chunks = [
        ExtractedChunk(text=("revenue useful evidence " * 300) + str(index), source=f"page {index}")
        for index in range(8)
    ]
    upload = EphemeralUpload(
        id="attachment", owner_user_id=1, name="report.pdf", extension=".pdf",
        media_type="application/pdf", size_bytes=10, created_at=utc_iso(),
        expires_at=utc_iso(), chunks=chunks, source_locators=[], warnings=[],
    )
    selected = select_attachment_context([upload], "What was revenue?")
    optimized = optimize_web_turn(
        "What was revenue?", attachment_prompt_context=selected, has_attachments=True,
    )
    assert len(selected) <= 8000
    assert optimized.attachment_chars_sent <= 8000
    assert selected.count("[report.pdf") <= 5


def test_task_aware_lite_ordering_never_crosses_tier(monkeypatch):
    monkeypatch.setenv("SWICO_LITE_MODEL_PRIMARY", "gpt-5.4-mini")
    monkeypatch.setenv("SWICO_LITE_MODEL_FALLBACKS", "gpt-5.4-nano")
    router = OpenAIModelRouter()
    simple = router.select_swico_candidates(
        "lite", "What is AI?", user_tier="paid", estimated_input_tokens=300,
        max_output_tokens=220, answer_class="simple",
    )
    assert [item.model for item in simple] == ["gpt-5.4-nano", "gpt-5.4-mini"]
    assert router.last_selection_metadata["primary_model_candidate"] == "gpt-5.4-mini"

    complex_candidates = router.select_swico_candidates(
        "lite", "Design a detailed backend architecture", user_tier="paid",
        estimated_input_tokens=300, max_output_tokens=700, answer_class="detailed",
    )
    assert [item.model for item in complex_candidates] == ["gpt-5.4-mini", "gpt-5.4-nano"]
    assert {item.model for item in simple + complex_candidates} == {"gpt-5.4-mini", "gpt-5.4-nano"}


class _Stream:
    def __init__(self, values):
        self.values = iter(values)

    def __iter__(self):
        return self

    def __next__(self):
        value = next(self.values)
        if isinstance(value, Exception):
            raise value
        return value

    def close(self):
        return None


def _chunk(text: str = "", usage=None):
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=SimpleNamespace(content=text))] if text else [],
        usage=usage,
    )


def _stream_request(max_attempts: int = 2) -> AIRequest:
    messages = [{"role": "system", "content": "stable"}, {"role": "user", "content": "question"}]
    serialized = serialize_provider_messages(messages)
    return AIRequest(
        1, "question", "en", "text", "attempt-test",
        {
            "client_surface": "web", "provider_messages": messages,
            "serialized_provider_prompt": serialized,
            "estimated_prompt_tokens": estimate_tokens(serialized),
            "max_provider_attempts": max_attempts,
        },
    )


def _attempt_route() -> AIRoute:
    return AIRoute(
        "openai", "gpt-4.1-nano", "openai_general", "test", "en", "general", 220,
        model_candidates=["gpt-4.1-nano", "gpt-4o-mini"],
        provider_endpoint_candidates=["chat_completions", "chat_completions"],
        metadata={"primary_model_candidate": "gpt-4.1-nano"},
    )


def test_normal_success_one_attempt_and_zero_usage_failure_can_fail_over():
    calls = []

    def successful(**kwargs):
        calls.append(kwargs)
        return _Stream([_chunk("ok")])

    provider = OpenAIProvider(SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=successful))))
    response = provider.stream_complete(_stream_request(), _attempt_route(), lambda _value: None)
    assert response.raw["provider_attempts"] == 1
    assert response.raw["fallback_attempted"] is False
    assert len(calls) == 1
    assert all("prompt_cache" not in key for key in calls[0])

    calls.clear()

    def fail_then_succeed(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise RuntimeError("connect failed")
        return _Stream([_chunk("fallback")])

    provider = OpenAIProvider(SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=fail_then_succeed))))
    response = provider.stream_complete(_stream_request(), _attempt_route(), lambda _value: None)
    assert response.text == "fallback"
    assert response.raw["provider_attempts"] == 2
    assert response.raw["fallback_attempted"] is True
    assert len(calls) == 2


def test_provider_budget_guard_uses_exact_full_prompt(monkeypatch):
    captured = {}

    def budget(_session, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr("app.ai.providers.openai_provider.enforce_openai_budget", budget)
    provider = OpenAIProvider(SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **_kwargs: _Stream([_chunk("ok")]))),
    ))
    request = _stream_request()
    provider.stream_complete(request, _attempt_route(), lambda _value: None)
    router = OpenAIModelRouter()
    expected = router.estimate_cost(
        captured["model"], request.metadata["estimated_prompt_tokens"], 220,
    )
    assert captured["estimated_cost_usd"] == expected
    assert request.metadata["estimated_prompt_tokens"] > estimate_tokens(request.message)


def test_no_retry_after_partial_output_or_usage():
    calls = []

    def partial(**kwargs):
        calls.append(kwargs)
        return _Stream([_chunk("partial"), RuntimeError("stream broke")])

    provider = OpenAIProvider(SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=partial))))
    with pytest.raises(RuntimeError):
        provider.stream_complete(_stream_request(), _attempt_route(), lambda _value: None)
    assert len(calls) == 1

    calls.clear()
    usage = SimpleNamespace(prompt_tokens=10, completion_tokens=0, prompt_tokens_details=None)

    def usage_then_error(**kwargs):
        calls.append(kwargs)
        return _Stream([_chunk(usage=usage), RuntimeError("stream broke")])

    provider = OpenAIProvider(SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=usage_then_error))))
    with pytest.raises(RuntimeError):
        provider.stream_complete(_stream_request(), _attempt_route(), lambda _value: None)
    assert len(calls) == 1


def test_cache_hit_precedes_reservation_and_cache_failure_fails_open(client, monkeypatch):
    create_test_user("cache-web", "cache-web@example.com")
    import app.web_api.chat_service as service
    original_create_reservation = service.create_usage_reservation
    cached = AIProviderResponse(
        text="Cached answer", provider="cache", model=None, route="global_knowledge_cache",
        reason="hit", language="en", intent="general",
        raw={"cache_hit": True, "cache_hit_source": "L3_global_qa"},
    )
    monkeypatch.setattr("app.web_api.chat_service._cache_response", lambda *args: cached)
    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation",
        lambda *args, **kwargs: pytest.fail("cache hit must not reserve"),
    )
    hit = client.post(
        "/api/web/chat/stream", headers=auth_headers("cache-web", "cache-web@example.com"),
        json={"request_id": "81000000-0000-4000-8000-000000000001", "message": "What is a compiler?"},
    )
    assert hit.status_code == 200 and "Cached answer" in hit.text
    with SessionLocal() as session:
        assert session.exec(select(UsageCharge)).all() == []

    monkeypatch.setattr("app.web_api.chat_service._cache_response", lambda *args: None)
    monkeypatch.setattr("app.web_api.chat_service.create_usage_reservation", original_create_reservation)
    fell_through = client.post(
        "/api/web/chat/stream", headers=auth_headers("cache-web", "cache-web@example.com"),
        json={"request_id": "81000000-0000-4000-8000-000000000002", "message": "What is a parser?"},
    )
    assert fell_through.status_code == 402


def test_exact_full_prompt_estimate_drives_reservation_and_metadata(client, monkeypatch):
    user = create_test_user("exact-prompt", "exact-prompt@example.com")
    _fund(int(user.id))
    captured = {}
    import app.web_api.chat_service as service

    original_reserve = service.reserve_price

    def reserve(provider, model, input_tokens, output_tokens):
        captured["reserved_input_tokens"] = input_tokens
        return original_reserve(provider, model, input_tokens, output_tokens)

    def complete(self, request, route, on_delta):
        captured["request"] = request
        on_delta("answer")
        return AIProviderResponse(
            text="answer", provider="openai", model=route.model, route=route.route,
            reason=route.reason, language="en", intent=route.intent,
            input_tokens=20, output_tokens=3,
            raw={"usage_actual": True, "provider_attempts": 1, "provider_calls_with_usage": 1},
        )

    monkeypatch.setattr(service, "reserve_price", reserve)
    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", complete)
    response = client.post(
        "/api/web/chat/stream", headers=auth_headers("exact-prompt", "exact-prompt@example.com"),
        json={"request_id": "82000000-0000-4000-8000-000000000001", "message": "Explain database indexes"},
    )
    assert response.status_code == 200
    request = captured["request"]
    exact = estimate_tokens(request.metadata["serialized_provider_prompt"])
    assert captured["reserved_input_tokens"] == request.metadata["estimated_prompt_tokens"] == exact
    assert exact > estimate_tokens(request.message)
    with SessionLocal() as session:
        assistant = session.exec(select(WebChatMessage).where(WebChatMessage.role == "assistant")).one()
        metadata = json.loads(assistant.metadata_json)
        assert metadata["estimated_prompt_tokens"] == exact
        assert metadata["provider_attempts"] == 1
        serialized = assistant.metadata_json.lower()
        assert "profile_context" not in serialized
        assert "attachment_prompt_context" not in serialized
        assert "recent conversation" not in serialized


def test_optimizer_disabled_preserves_legacy_six_turn_context(monkeypatch):
    monkeypatch.setenv("WEB_TURN_OPTIMIZER_ENABLED", "false")
    user = create_test_user("legacy-opt", "legacy-opt@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Legacy")
        session.add(thread); session.flush()
        for index in range(6):
            request_id = f"83000000-0000-4000-8000-{index:012d}"
            session.add(WebChatMessage(thread_id=thread.id, user_id=int(user.id), role="user", content=f"q{index}", request_id=request_id, status="complete"))
            session.add(WebChatMessage(thread_id=thread.id, user_id=int(user.id), role="assistant", content=f"a{index}", request_id=request_id, status="complete"))
        session.commit(); thread_id = thread.id
    monkeypatch.setattr("app.web_api.chat_service.create_usage_reservation", lambda *args, **kwargs: None)
    prepared = prepare_web_turn(
        user_id=int(user.id), message="What is AI?", request_id="83000000-0000-4000-8000-999999999999",
        thread_id=thread_id, reply_language="en",
    )
    assert len(prepared.ai_request.context_turns) == 6
    assert prepared.optimization.optimization_route == "legacy_optimizer_disabled"
