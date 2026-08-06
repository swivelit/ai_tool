from __future__ import annotations

from datetime import timedelta
import json

from sqlmodel import select

from app.ai.prompts import build_provider_messages
from app.ai.types import AIRequest, AIRoute
from app.continuous_learning import distill_web_turn_facts
from app.database import SessionLocal
from app.billing.pricing import openai_price
from app.global_qa_cache import (
    lookup_approved_global_cache, reset_global_qa_hot_cache_for_tests,
)
from app.job_queue import enqueue_post_turn_distillation
from app.models import (
    GlobalQACache, UsageCharge, User, WebChatMessage, WebChatThread, WebMemoryFact,
    WebUsagePreferences,
)
from app.openai_model_router import OpenAIModelRouter
from app.time_utils import utc_now
from app.web_api.deterministic_answers import (
    deterministic_scope_decision,
    try_deterministic_answer,
)
from app.web_api.chat_service import execute_web_turn, prepare_web_turn
from app.web_api.request_coordinator import _apply_prompt_budget
from app.web_api.router import _serialize_message
from app.web_api.turn_optimizer import WebTurnOptimization, select_context_turns
from app.web_ai.generation.output_contract import extract_output_contract
from app.web_api.web_memory import (
    parse_durable_memory_fact,
    retrieve_memory,
)
from conftest import auth_headers, create_test_user


def _route() -> AIRoute:
    return AIRoute(
        "openai", "gpt-5.4-mini", "provider_standalone", "test",
        "en", "general", 320,
    )


def test_ws1_semantic_cache_uses_vector_candidates(monkeypatch):
    monkeypatch.setenv("GLOBAL_QA_SEMANTIC_ENABLED", "true")
    monkeypatch.setattr(
        "app.global_qa_cache.cached_text_embedding", lambda *args, **kwargs: [1.0, 0.0]
    )
    reset_global_qa_hot_cache_for_tests()
    with SessionLocal() as session:
        row = GlobalQACache(
            canonical_question="What does FIFO mean?",
            normalized_question="what does fifo mean",
            answer="First in, first out.",
            answer_language="en",
            scope="global",
            status="approved",
            hit_count=2,
            distinct_user_count=2,
            observed_question_count=2,
            source_question_hashes_json="[]",
            answer_hash="fifo",
            embedding_json=json.dumps([1.0, 0.0]),
            embedding_kind="openai:text-embedding-3-small",
            embedding_norm=1.0,
            real_embedding_json=json.dumps([1.0, 0.0]),
            real_embedding_norm=1.0,
            real_embedding_kind="openai:text-embedding-3-small",
            confidence=0.9,
            safety_label="general",
            expires_at=utc_now() + timedelta(days=1),
        )
        session.add(row); session.commit(); session.refresh(row)

        class Store:
            def search(self, *args, **kwargs):
                return [{"source_id": str(row.id), "score_semantic": 1.0}]

        monkeypatch.setattr("app.global_qa_cache.get_vector_store", lambda: Store())
        hit = lookup_approved_global_cache(
            session, "Explain queue insertion order", "en"
        )
    assert hit and hit["cache_hit_kind"] == "semantic"


def test_ws2_memory_facts_are_embedding_ranked(monkeypatch):
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    monkeypatch.setenv("WEB_MEMORY_FACT_RANKING_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.web_memory.cached_text_embedding",
        lambda *args, **kwargs: [1.0, 0.0],
    )
    user = create_test_user("ws2", "ws2@example.com")
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), memory_enabled=True))
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="pref:one",
            value_text="Prefers concise replies", category="preference",
            embedding_json="[1,0]", embedding_norm=1.0,
        ))
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="pref:two",
            value_text="Likes unrelated sports", category="preference",
            embedding_json="[0,1]", embedding_norm=1.0,
        ))
        session.commit()
        result = retrieve_memory(
            session, user_id=int(user.id), message="How should you reply?",
            current_thread_id=None,
        )
    assert "concise" in result.prompt_context
    assert "sports" not in result.prompt_context


def test_ws3_deterministic_arithmetic_and_units_skip_models(monkeypatch):
    user = create_test_user("ws3", "ws3@example.com")
    with SessionLocal() as session:
        arithmetic = try_deterministic_answer(
            session, user_id=int(user.id), message="calculate (12 + 3) * 2",
            reply_language="en", request_id="ws3-a",
        )
        conversion = try_deterministic_answer(
            session, user_id=int(user.id), message="5 km to m",
            reply_language="en", request_id="ws3-b",
        )
    assert arithmetic and arithmetic.provider == "backend_tool" and "= 30" in arithmetic.text
    assert conversion and "5000 m" in conversion.text


def test_ws4_answer_class_selects_lowest_initial_tier(monkeypatch):
    monkeypatch.setenv("WEB_MODEL_LADDER_DOWNGRADE_ENABLED", "true")
    router = OpenAIModelRouter()
    choices = router.select_web_ladder_candidates(
        saved_tier="standard", answer_class="simple", message="What is a queue?",
        user_tier="paid", estimated_input_tokens=20, max_output_tokens=100,
    )
    assert choices
    assert router.last_selection_metadata["initial_tier"] == "lite"


def test_ws5_distillation_is_heuristic_and_bounded(monkeypatch):
    monkeypatch.setenv("WEB_POST_TURN_DISTILLATION_ENABLED", "true")
    monkeypatch.setattr(
        "app.continuous_learning.cached_text_embedding",
        lambda value, **kwargs: [1.0, float(len(value) % 2)],
    )
    user = create_test_user("ws5", "ws5@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Facts")
        session.add(thread); session.flush()
        message = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="My name is Hari. I work at Swico. I prefer short replies.",
            request_id="ws5", status="complete",
        )
        assistant = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="I saved those durable preferences.",
            request_id="ws5", status="complete",
        )
        session.add(message); session.add(assistant)
        session.commit(); session.refresh(message); session.refresh(assistant)
        result = distill_web_turn_facts(
            session, user_id=int(user.id), user_message_id=message.id,
            assistant_message_id=assistant.id,
            thread_id=thread.id,
        )
    assert result["extracted"] == 2
    assert result["inserted"] <= 2


def test_ws5_distillation_considers_completed_assistant_decision(monkeypatch):
    monkeypatch.setenv("WEB_POST_TURN_DISTILLATION_ENABLED", "true")
    monkeypatch.setattr(
        "app.continuous_learning.cached_text_embedding",
        lambda *_args, **_kwargs: [1.0, 0.0],
    )
    user = create_test_user("ws5-assistant", "ws5-assistant@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Decision")
        session.add(thread); session.flush()
        request = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="Which stack did we finally decide on?",
            request_id="ws5-assistant", status="complete",
        )
        answer = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="We decided to use PostgreSQL with FastAPI.",
            request_id="ws5-assistant", status="complete",
        )
        session.add(request); session.add(answer); session.commit()
        result = distill_web_turn_facts(
            session, user_id=int(user.id), user_message_id=request.id,
            assistant_message_id=answer.id, thread_id=thread.id,
        )
        facts = session.exec(select(WebMemoryFact).where(
            WebMemoryFact.user_id == int(user.id)
        )).all()
    assert result["inserted"] == 1
    assert facts[0].source_message_id == answer.id
    assert "PostgreSQL" in facts[0].value_text


def test_ws5_distillation_reuses_explicit_parser_and_deduplicates_sync_fact(
    monkeypatch,
):
    monkeypatch.setenv("WEB_POST_TURN_DISTILLATION_ENABLED", "true")
    monkeypatch.setattr(
        "app.continuous_learning.cached_text_embedding",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("exactly deduplicated facts must not be embedded")
        ),
    )
    text = (
        "Remember that my preferred reply style is concise Tamil-English."
    )
    parsed = parse_durable_memory_fact(text)
    assert parsed is not None and parsed.category == "reply_style"
    user = create_test_user("ws5-explicit", "ws5-explicit@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Preference")
        session.add(thread)
        session.flush()
        request = WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="user",
            content=text,
            request_id="ws5-explicit",
            status="complete",
        )
        answer = WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="assistant",
            content="Saved to cross-chat memory.",
            request_id="ws5-explicit",
            status="complete",
        )
        session.add(request)
        session.add(answer)
        session.flush()
        session.add(WebMemoryFact(
            user_id=int(user.id),
            normalized_key=parsed.normalized_key,
            value_text=parsed.value,
            category=parsed.category,
            source_thread_id=thread.id,
            source_message_id=request.id,
        ))
        session.commit()
        result = distill_web_turn_facts(
            session,
            user_id=int(user.id),
            user_message_id=request.id,
            assistant_message_id=answer.id,
            thread_id=thread.id,
        )
        facts = session.exec(
            select(WebMemoryFact).where(WebMemoryFact.user_id == int(user.id))
        ).all()
    assert result["inserted"] == 0
    assert result["deduped"] == 1
    assert len(facts) == 1


def test_ws5_distillation_job_payload_is_assistant_idempotent():
    user = create_test_user("ws5-job", "ws5-job@example.com")
    with SessionLocal() as session:
        first = enqueue_post_turn_distillation(
            session, user_id=int(user.id), user_message_id="user-message",
            assistant_message_id="assistant-message", thread_id="thread",
        )
        second = enqueue_post_turn_distillation(
            session, user_id=int(user.id), user_message_id="user-message",
            assistant_message_id="assistant-message", thread_id="thread",
        )
        payload = json.loads(first.payload_json)
    assert first.id == second.id
    assert payload["assistant_message_id"] == "assistant-message"


def test_ws3_configured_billing_faq_is_model_and_embedding_free(monkeypatch):
    monkeypatch.setenv("BILLING_TOPUP_PACKAGES_PAISE", "2500,9900")
    monkeypatch.setenv("BILLING_MIN_TOPUP_PAISE", "2500")
    monkeypatch.setenv("BILLING_MAX_TOPUP_PAISE", "20000")
    monkeypatch.setenv("BILLING_ENFORCE_TOPUP_PACKAGES", "true")
    user = create_test_user("ws3-billing", "ws3-billing@example.com")
    with SessionLocal() as session:
        response = try_deterministic_answer(
            session, user_id=int(user.id),
            message="What recharge packages are available?",
            reply_language="en", request_id="ws3-billing",
        )
    assert response and response.provider == "backend_tool"
    assert "₹25" in response.text and "₹99" in response.text
    assert response.raw["provider_attempts"] == 0
    assert response.raw["provenance"] == ["backend_tool"]


def test_deterministic_scope_rejects_multisection_creation_brief():
    user = create_test_user("scope-brief", "scope-brief@example.com")
    brief = """Create a responsive landing page for a collaboration product.

1. Hero — include a concise value proposition and two calls to action.
2. Features — explain realtime editing, approvals, and version history.
3. Security — cover access controls, encryption, and audit history.
4. Pricing — show the available plans and what each includes.
5. FAQ — compare plans and pricing side by side.

Return complete accessible HTML, CSS, and JavaScript in fenced code blocks."""
    with SessionLocal() as session:
        response = try_deterministic_answer(
            session,
            user_id=int(user.id),
            message=brief,
            reply_language="en",
            request_id="scope-brief",
        )
    decision = deterministic_scope_decision(brief, answer_class="long_form")
    assert response is None
    assert decision.intent == "billing_tier_pricing"
    assert decision.scope_gate_reason == "answer_class_long_form"


def test_deterministic_scope_keeps_direct_pricing_question():
    user = create_test_user("scope-pricing", "scope-pricing@example.com")
    with SessionLocal() as session:
        response = try_deterministic_answer(
            session,
            user_id=int(user.id),
            message="What are Swico's plans and pricing?",
            reply_language="en",
            request_id="scope-pricing",
        )
    assert response is not None
    assert response.intent == "billing_tier_pricing"


def test_deterministic_scope_keeps_direct_tanglish_pricing_question():
    user = create_test_user(
        "scope-pricing-tanglish", "scope-pricing-tanglish@example.com"
    )
    with SessionLocal() as session:
        response = try_deterministic_answer(
            session,
            user_id=int(user.id),
            message="Swico plans enna, pricing sollunga?",
            reply_language="en",
            request_id="scope-pricing-tanglish",
        )
    assert response is not None
    assert response.intent == "billing_tier_pricing"
    assert "Swico-oda" in response.text


def test_pricing_intent_rejects_unqualified_mode_questions():
    user = create_test_user(
        "scope-unqualified-mode", "scope-unqualified-mode@example.com"
    )
    messages = (
        "What is the most likely failure mode, and what should I change first?",
        "The system has two failure modes; what causes each?",
        "How do I turn on dark mode?",
    )
    with SessionLocal() as session:
        for index, message in enumerate(messages, start=1):
            decision = deterministic_scope_decision(message)
            response = try_deterministic_answer(
                session,
                user_id=int(user.id),
                message=message,
                reply_language="en",
                request_id=f"scope-unqualified-mode-{index}",
            )
            assert decision.intent != "billing_tier_pricing", message
            assert response is None, message


def test_deterministic_scope_character_and_line_boundaries():
    base = "What are Swico plans and pricing?"
    exactly_240 = base + ("x" * (240 - len(base)))
    assert len(exactly_240) == 240
    assert deterministic_scope_decision(exactly_240).scope_gate_reason is None
    assert deterministic_scope_decision(exactly_240 + "x").scope_gate_reason == (
        "message_too_long"
    )
    assert deterministic_scope_decision(
        "What are Swico plans and pricing?\nPlease compare them."
    ).scope_gate_reason is None
    assert deterministic_scope_decision(
        "What are Swico plans and pricing?\nPlease compare them.\nKeep it short."
    ).scope_gate_reason == "too_many_nonempty_lines"
    assert deterministic_scope_decision(
        "Convert 5 km to miles\nUse it in lesson two.\nExplain the lesson."
    ).scope_gate_reason == "too_many_nonempty_lines"


def test_multiline_scope_gate_does_not_remove_the_output_contract():
    prompt = """Write a micro-story of exactly 120 words.
Include the phrase “blue umbrella” exactly once.
End with the word “home”.
Do not include a title."""

    assert deterministic_scope_decision(prompt).scope_gate_reason == (
        "too_many_nonempty_lines"
    )
    contract = extract_output_contract(prompt)
    assert contract.exact_word_count == 120
    assert contract.required_phrase == "blue umbrella"
    assert contract.required_phrase_count == 1
    assert contract.required_final_word == "home"
    assert contract.no_title is True


def test_deterministic_scope_creation_verb_and_early_match_boundaries():
    assert deterministic_scope_decision(
        "Design a page that asks: What are Swico plans and pricing?"
    ).scope_gate_reason == "creation_task"
    assert deterministic_scope_decision(
        "Write a profile explaining what Swico is."
    ).scope_gate_reason == "creation_task"

    early = ("x" * 158) + " plans and pricing available?"
    late = ("x" * 159) + " plans and pricing available?"
    assert early.index("plans") == 159
    assert deterministic_scope_decision(early).scope_gate_reason is None
    assert late.index("plans") == 160
    assert deterministic_scope_decision(late).scope_gate_reason == (
        "intent_match_too_late"
    )


def test_deterministic_scope_answer_class_precedes_short_intent(caplog):
    caplog.set_level("INFO", logger="app.web_api.deterministic_answers")
    decision = deterministic_scope_decision(
        "What are Swico plans and pricing?", answer_class="detailed",
        emit_log=True,
    )
    assert decision.scope_gate_reason == "answer_class_detailed"
    record = next(
        item for item in caplog.records
        if item.getMessage() == "web_deterministic_scope_suppressed"
    )
    assert record.intent == "billing_tier_pricing"
    assert record.reason == "answer_class_detailed"


def test_ws3_billing_faq_returns_before_cache_reservation_and_provider(
    monkeypatch,
):
    monkeypatch.setenv("WEB_DETERMINISTIC_TOOLS_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("deterministic billing must precede cache")
        ),
    )
    user = create_test_user("ws3-routing", "ws3-routing@example.com")
    prepared = prepare_web_turn(
        user_id=int(user.id), message="recharge panna eppadi",
        request_id="ws3-routing", thread_id=None, reply_language="en",
    )
    assert prepared.optimization is not None
    assert prepared.optimization.metrics["deterministic_intent"] == (
        "billing_topup_how"
    )
    assert prepared.optimization.metrics["deterministic_route"] == (
        "backend_tool"
    )
    assert prepared.optimization.metrics["scope_gate_reason"] is None

    class ProviderSpy:
        def complete(self, *_args, **_kwargs):
            raise AssertionError("deterministic billing must skip provider")

        stream_complete = complete

    completed = execute_web_turn(
        prepared, providers={"openai": ProviderSpy(), "sarvam": ProviderSpy()}
    )
    assert completed.response.provider == "backend_tool"
    with SessionLocal() as session:
        assert session.exec(select(UsageCharge)).all() == []


def test_deterministic_scope_sends_long_pricing_creation_to_generation(
    monkeypatch,
):
    monkeypatch.setenv("WEB_DETERMINISTIC_TOOLS_ENABLED", "true")
    user = create_test_user(
        "scope-generation", "scope-generation@example.com"
    )
    message = """Create a responsive landing page for a collaboration product.

1. Hero — include a concise value proposition and two calls to action.
2. Features — explain realtime editing, approvals, and version history.
3. Security — cover access controls, encryption, and audit history.
4. Pricing — show the available plans and what each includes.
5. FAQ — compare plans and pricing side by side.

Return complete accessible HTML, CSS, and JavaScript in fenced code blocks."""
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message=message,
        request_id="scope-generation",
        thread_id=None,
        reply_language="en",
        billing_exempt=True,
    )
    assert prepared.precomputed_response is None
    assert prepared.route.provider in {"openai", "sarvam"}
    assert prepared.optimization is not None
    assert prepared.optimization.metrics["deterministic_intent"] == (
        "billing_tier_pricing"
    )
    assert prepared.optimization.metrics["deterministic_route"] is None
    assert prepared.optimization.metrics["scope_gate_reason"] in {
        "answer_class_detailed", "answer_class_long_form", "message_too_long",
        "too_many_nonempty_lines",
    }


def test_ws6_first_prompt_message_is_byte_stable(monkeypatch):
    monkeypatch.setenv("WEB_PROMPT_PREFIX_STABLE_ENABLED", "true")
    first = AIRequest(1, "Explain queues", "en", "text", "one", {
        "client_surface": "web", "answer_class": "simple",
    })
    second = AIRequest(1, "A different request", "ta", "text", "two", {
        "client_surface": "web", "answer_class": "detailed",
    })
    left = build_provider_messages(first, _route(), provider="openai")[0]["content"]
    right = build_provider_messages(second, _route(), provider="openai")[0]["content"]
    assert left.encode() == right.encode()


def test_ws6_dynamic_context_follows_stable_prefix_in_fixed_order(monkeypatch):
    monkeypatch.setenv("WEB_PROMPT_PREFIX_STABLE_ENABLED", "true")
    request = AIRequest(
        1, "Current question", "ta", "text", "dynamic-order",
        {
            "client_surface": "web",
            "answer_class": "normal",
            "profile_prompt_context": '{"tone":"concise"}',
            "memory_prompt_context": "Saved memory",
            "attachment_prompt_context": "[document] excerpt",
        },
        context_turns=[{"user": "Earlier question", "assistant": "Earlier answer"}],
    )
    messages = build_provider_messages(request, _route(), provider="openai")
    contents = [item["content"] for item in messages]
    assert "Provider route class" in contents[0]
    dynamic_index = next(index for index, value in enumerate(contents) if "Requested reply language" in value)
    profile_index = next(index for index, value in enumerate(contents) if "Saved user profile" in value)
    memory_index = next(index for index, value in enumerate(contents) if "Relevant saved memory" in value)
    document_index = next(index for index, value in enumerate(contents) if "BEGIN UNTRUSTED" in value)
    history_index = next(index for index, value in enumerate(contents) if "Bounded same-chat history" in value)
    assert 0 < dynamic_index < profile_index < memory_index < document_index < history_index
    assert messages[-1] == {"role": "user", "content": "Current question"}


def test_ws6_same_chat_instruction_resolves_technical_references_and_boundaries():
    request = AIRequest(
        1,
        "Show the transaction boundary for that fix in pseudocode.",
        "en",
        "text",
        "continuity-boundary",
        {"client_surface": "web", "answer_class": "detailed"},
        context_turns=[{
            "user": (
                "I am building an inventory API with FastAPI, PostgreSQL, and "
                "Redis. Retries sometimes reserve stock twice."
            ),
            "assistant": "Use an idempotency key and a unique constraint.",
        }],
    )

    messages = build_provider_messages(request, _route(), provider="openai")
    history_instruction = next(
        str(message["content"])
        for message in messages
        if "Bounded same-chat history" in str(message["content"])
    )
    assert "Resolve references" in history_instruction
    assert "preserve the named technical context" in history_instruction
    assert "implementation or consistency boundary" in history_instruction
    assert messages[-1]["content"] == request.message


def test_prompt_cache_write_tokens_cannot_be_undercharged():
    without_write = openai_price(
        "gpt-4.1-nano", input_tokens=10, output_tokens=0,
        cached_input_tokens=10, cache_write_tokens=0,
    )
    with_write = openai_price(
        "gpt-4.1-nano", input_tokens=10, output_tokens=0,
        cached_input_tokens=10, cache_write_tokens=10,
    )
    assert with_write.amount > without_write.amount
    assert with_write.snapshot["cache_write_tokens"] == 10


def test_ws7_prompt_allocator_trims_sections(monkeypatch):
    monkeypatch.setenv("WEB_MAX_PROMPT_TOKENS", "650")
    optimization = WebTurnOptimization(
        optimization_route="provider_contextual",
        is_contextual_followup=True,
        selected_context_turns=[
            {"user": "old " * 500, "assistant": "answer " * 500},
            {"user": "new " * 200, "assistant": "answer " * 200},
        ],
        compact_profile_prompt="profile " * 400,
        attachment_prompt_context="document " * 1000,
    )
    bounded, memory = _apply_prompt_budget(
        optimization, message="current request", memory_context="memory " * 500
    )
    assert bounded.attachment_chars_sent < len(optimization.attachment_prompt_context)
    assert len(memory) < 3500
    assert bounded.metrics["prompt_token_budget"] == 650


def test_ws8_history_keeps_last_two_and_ranks_relevance(monkeypatch):
    monkeypatch.setenv("WEB_CONTEXT_RELEVANCE_RANKING_ENABLED", "true")
    monkeypatch.setenv("WEB_CONTEXT_MAX_TURNS", "3")
    monkeypatch.setenv("WEB_CONTEXT_MAX_CHARS", "5000")
    turns = [
        {"user": "Python queue implementation", "assistant": "Use deque"},
        {"user": "Dinner ideas", "assistant": "Pasta"},
        {"user": "Weather", "assistant": "Sunny"},
        {"user": "Continue that", "assistant": "Okay"},
    ]
    selected, _ = select_context_turns(
        turns, contextual=True, current_message="More about Python queues"
    )
    assert turns[-2] in selected and turns[-1] in selected
    assert turns[0] in selected


def test_ws9_memory_replaces_history_budget(monkeypatch):
    monkeypatch.setenv("WEB_MAX_PROMPT_TOKENS", "1000")
    base = WebTurnOptimization(
        optimization_route="provider_contextual", is_contextual_followup=True,
        selected_context_turns=[
            {"user": "history " * 300, "assistant": "answer " * 300}
        ],
    )
    without, _ = _apply_prompt_budget(base, message="current", memory_context="")
    with_memory, _ = _apply_prompt_budget(
        base, message="current", memory_context="remembered " * 80
    )
    assert with_memory.metrics["history_token_allocation"] < without.metrics["history_token_allocation"]


def test_ws10_json_backend_tool_pretty_prints():
    user = create_test_user("ws10", "ws10@example.com")
    with SessionLocal() as session:
        response = try_deterministic_answer(
            session, user_id=int(user.id),
            message='Pretty-print this JSON: {"b":2,"a":1}',
            reply_language="en", request_id="ws10",
        )
    assert response and response.provider == "backend_tool"
    assert '"b": 2' in response.text


def test_time_tool_requires_a_valid_saved_iana_timezone():
    user = create_test_user("time-invalid-zone", "time-invalid-zone@example.com")
    with SessionLocal() as session:
        stored = session.get(User, int(user.id))
        assert stored is not None
        stored.timezone = "Not/A_Timezone"
        session.add(stored)
        session.commit()
        response = try_deterministic_answer(
            session,
            user_id=int(user.id),
            message="What time is it?",
            reply_language="en",
            request_id="time-invalid-zone",
        )
    assert response is not None
    assert "Settings → Profile" in response.text


def test_ws11_feedback_is_owner_scoped_and_corrects_cache(client, monkeypatch):
    monkeypatch.setenv("WEB_ANSWER_FEEDBACK_ENABLED", "true")
    user = create_test_user("ws11", "ws11@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Feedback")
        session.add(thread); session.flush()
        cache = GlobalQACache(
            canonical_question="Stable question", normalized_question="stable question",
            answer="Stable answer", answer_language="en", status="approved",
            hit_count=2, distinct_user_count=2, observed_question_count=2,
            source_question_hashes_json="[]", answer_hash="stable",
            confidence=0.5, safety_label="general",
        )
        session.add(cache); session.flush()
        message = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="Cached", request_id="ws11", status="complete",
            metadata_json=json.dumps({"cache_row_id": cache.id}),
        )
        session.add(message); session.commit(); message_id = message.id
    response = client.post(
        f"/api/web/messages/{message_id}/feedback",
        headers=auth_headers("ws11", "ws11@example.com"),
        json={"rating": "down"},
    )
    assert response.status_code == 200
    assert response.json()["rating"] == "down"


def test_ws12_content_search_sqlite_fallback(client, monkeypatch):
    monkeypatch.setenv("WEB_CONTENT_SEARCH_ENABLED", "true")
    user = create_test_user("ws12", "ws12@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Search")
        session.add(thread); session.flush()
        session.add(WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="The rare pineapple keyword is here.", request_id="ws12",
            status="complete",
        ))
        archived = WebChatThread(
            user_id=int(user.id), title="Archived",
            archived_at=utc_now(),
        )
        session.add(archived); session.flush()
        session.add(WebChatMessage(
            thread_id=archived.id, user_id=int(user.id), role="user",
            content="An archived pineapple must stay hidden.",
            request_id="ws12-archived", status="complete",
        ))
        session.add(WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="A superseded pineapple must stay hidden.",
            request_id="ws12-old", status="complete",
            superseded_at=utc_now(),
        ))
        session.commit()
    response = client.get(
        "/api/web/search?q=pineapple",
        headers=auth_headers("ws12", "ws12@example.com"),
    )
    assert response.status_code == 200
    assert len(response.json()["items"]) == 1
    assert response.json()["items"][0]["source_kind"] == "message"


def test_ws13_provenance_is_bounded_and_flagged(monkeypatch):
    monkeypatch.setenv("WEB_RESPONSE_PROVENANCE_ENABLED", "true")
    user = create_test_user("ws13", "ws13@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Provenance")
        session.add(thread); session.flush()
        message = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="Answer", request_id="ws13", status="complete",
            metadata_json=json.dumps({
                "provenance": ["memory", "backend_tool", "not_allowed"]
            }),
        )
        session.add(message); session.commit(); session.refresh(message)
        payload = _serialize_message(message)
    assert payload["provenance"] == ["memory", "backend_tool"]
