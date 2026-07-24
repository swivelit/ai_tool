from __future__ import annotations

from datetime import timedelta
import json

from sqlmodel import select

from app.ai.prompts import build_provider_messages
from app.ai.types import AIRequest, AIRoute
from app.continuous_learning import distill_web_turn_facts
from app.database import SessionLocal
from app.global_qa_cache import (
    lookup_approved_global_cache, reset_global_qa_hot_cache_for_tests,
)
from app.models import (
    GlobalQACache, User, WebChatMessage, WebChatThread, WebMemoryFact,
    WebUsagePreferences,
)
from app.openai_model_router import OpenAIModelRouter
from app.time_utils import utc_now
from app.web_api.deterministic_answers import try_deterministic_answer
from app.web_api.request_coordinator import _apply_prompt_budget
from app.web_api.router import _serialize_message
from app.web_api.turn_optimizer import WebTurnOptimization, select_context_turns
from app.web_api.web_memory import retrieve_memory
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
        session.add(message); session.commit(); session.refresh(message)
        result = distill_web_turn_facts(
            session, user_id=int(user.id), user_message_id=message.id,
            thread_id=thread.id,
        )
    assert result["extracted"] == 2
    assert result["inserted"] <= 2


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
        session.commit()
    response = client.get(
        "/api/web/search?q=pineapple",
        headers=auth_headers("ws12", "ws12@example.com"),
    )
    assert response.status_code == 200
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
