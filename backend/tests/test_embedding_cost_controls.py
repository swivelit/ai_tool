import json

from sqlmodel import select

from app.ai.orchestrator import run_text_turn
from app.ai.types import AIProviderResponse, AIRequest
from app.database import SessionLocal
from app.models import AIUsageEvent


class _Provider:
    def __init__(self):
        self.calls = 0

    def complete(self, request, route):
        self.calls += 1
        return AIProviderResponse(
            text="provider answer",
            provider="openai",
            model=route.model,
            route=route.route,
            reason=route.reason,
            language=route.language,
            intent=route.intent,
            raw={"model_candidates": route.model_candidates, "endpoint": "responses"},
        )


class _RagService:
    def __init__(self, hit=None):
        self.calls = 0
        self.hit = hit

    def try_answer(self, session, user_id, message):
        self.calls += 1
        return self.hit


def _request(message: str) -> AIRequest:
    return AIRequest(
        user_id=123,
        message=message,
        reply_language="en",
        channel="text",
        request_id="embedding-test",
        metadata={},
    )


def test_simple_english_chat_makes_zero_embedding_calls_by_default(monkeypatch):
    monkeypatch.setenv("AI_RAG_LOOKUP_FOR_SIMPLE_CHAT", "false")
    monkeypatch.setenv("AI_SEMANTIC_CACHE_LOOKUP_FOR_SIMPLE_CHAT", "false")
    rag = _RagService()
    provider = _Provider()

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("What is a compiler?"),
            existing_context={"local_rag_service": rag, "openai_provider": provider},
        )
        event = session.exec(select(AIUsageEvent)).one()

    metadata = json.loads(event.metadata_json)
    assert response.provider == "openai"
    assert rag.calls == 0
    assert provider.calls == 1
    assert metadata["embedding_calls"] == 0


def test_rag_intent_makes_one_embedding_call_max(monkeypatch):
    monkeypatch.setenv("AI_MAX_EMBEDDING_CALLS_PER_TURN", "1")
    rag = _RagService()
    provider = _Provider()

    with SessionLocal() as session:
        run_text_turn(
            session,
            _request("Search my saved documents about refund policy"),
            existing_context={"local_rag_service": rag, "openai_provider": provider},
        )
        event = session.exec(select(AIUsageEvent)).one()

    metadata = json.loads(event.metadata_json)
    assert rag.calls == 1
    assert provider.calls == 1
    assert metadata["embedding_calls"] == 1


def test_simple_chat_semantic_lookup_opt_in_allows_one_embedding(monkeypatch):
    monkeypatch.setenv("AI_SEMANTIC_CACHE_LOOKUP_FOR_SIMPLE_CHAT", "true")
    monkeypatch.setenv("AI_RAG_LOOKUP_FOR_SIMPLE_CHAT", "false")
    rag = _RagService()
    provider = _Provider()

    with SessionLocal() as session:
        run_text_turn(
            session,
            _request("What is a compiler?"),
            existing_context={"local_rag_service": rag, "openai_provider": provider},
        )

    assert rag.calls == 1
    assert provider.calls == 1


def test_high_confidence_rag_hit_returns_cache_after_one_embedding(monkeypatch):
    monkeypatch.setenv("AI_MAX_EMBEDDING_CALLS_PER_TURN", "1")
    hit = {
        "direct_answer_confidence": "0.95",
        "raw_english": "cached answer",
        "route_taken": "local_rag_cache",
        "predicted_label": "knowledge",
        "direct_answer_source": "local_rag",
    }
    rag = _RagService(hit=hit)
    provider = _Provider()

    with SessionLocal() as session:
        response = run_text_turn(
            session,
            _request("Search my saved notes about onboarding"),
            existing_context={"local_rag_service": rag, "openai_provider": provider},
        )

    assert response.provider == "cache"
    assert response.text == "cached answer"
    assert rag.calls == 1
    assert provider.calls == 0
