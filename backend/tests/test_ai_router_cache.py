from __future__ import annotations

import json
from datetime import timedelta

import app.main as main_module
from app.ai.types import AIProviderResponse
from app.database import SessionLocal
from app.global_qa_cache import (
    GLOBAL_QA_EMBEDDING_KIND,
    answer_hash,
    embed_question_for_global_cache,
    normalize_question,
)
from app.models import GlobalQACache, QACache
from app.time_utils import utc_now
from conftest import auth_headers, create_test_user
from sqlmodel import select


def _approved_global_cache(question: str, answer: str) -> GlobalQACache:
    normalized = normalize_question(question)
    embedding, embedding_norm = embed_question_for_global_cache(normalized)
    now = utc_now()
    return GlobalQACache(
        canonical_question=question,
        normalized_question=normalized,
        answer=answer,
        answer_language="en",
        topic="compiler",
        status="approved",
        hit_count=2,
        distinct_user_count=2,
        observed_question_count=2,
        source_question_hashes_json=json.dumps([]),
        observed_safe_questions_json=json.dumps([normalized]),
        aliases_json=json.dumps(["explain compiler"]),
        answer_hash=answer_hash(answer),
        embedding_json=json.dumps(embedding),
        embedding_kind=GLOBAL_QA_EMBEDDING_KIND,
        embedding_norm=embedding_norm,
        confidence=0.95,
        safety_label="general",
        model_used="cheap-test-model",
        first_seen_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(days=30),
        created_at=now,
        updated_at=now,
    )


def _provider_answer(text: str = "A compiler translates source code into executable output.") -> AIProviderResponse:
    return AIProviderResponse(
        text=text,
        provider="openai",
        model="cheap-test-model",
        route="openai_general",
        reason="test_provider_answer",
        language="en",
        intent="general",
        input_tokens=10,
        output_tokens=12,
        raw={"reply_language": "en", "model_tier": "cheap"},
    )


def test_ai_router_approved_global_cache_hit_skips_provider(client, monkeypatch):
    create_test_user("cache-uid", "cache@example.com")
    with SessionLocal() as session:
        row = _approved_global_cache(
            "What is a compiler?",
            "A compiler translates source code into another executable form.",
        )
        session.add(row)
        session.commit()

    def fail_run_text_turn(*args, **kwargs):  # pragma: no cover - assertion path
        raise AssertionError("provider/router should not be called on global cache hit")

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fail_run_text_turn)

    response = client.post(
        "/api/chat",
        headers=auth_headers("cache-uid", "cache@example.com"),
        json={"message": "Explain compiler", "reply_language": "en", "request_id": "cache-hit"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["pipeline"]["route_taken"] == "global_knowledge_cache"
    assert payload["pipeline"]["cache_hit"] == "true"
    assert payload["meta"]["source"] == "global_qa_cache"

    with SessionLocal() as session:
        assert list(session.exec(select(QACache)).all()) == []


def test_ai_router_records_safe_provider_answer_in_global_and_user_cache(client, monkeypatch):
    user = create_test_user("record-uid", "record@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", lambda *args, **kwargs: _provider_answer())

    response = client.post(
        "/api/chat",
        headers=auth_headers("record-uid", "record@example.com"),
        json={"message": "What is a compiler?", "reply_language": "en", "request_id": "record-1"},
    )

    assert response.status_code == 200
    with SessionLocal() as session:
        qa = session.exec(select(QACache).where(QACache.user_id == user.id)).one()
        assert qa.hits == 1
        assert "compiler translates" in qa.answer
        global_row = session.exec(select(GlobalQACache)).one()
        assert global_row.status == "candidate"
        assert global_row.hit_count == 1


def test_ai_router_repeated_same_user_increments_user_qa_cache(client, monkeypatch):
    user = create_test_user("repeat-uid", "repeat@example.com")
    calls: list[str] = []

    def fake_run_text_turn(session, request, *, existing_context=None):
        calls.append(request.message)
        return _provider_answer()

    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", fake_run_text_turn)

    headers = auth_headers("repeat-uid", "repeat@example.com")
    for request_id in ("repeat-1", "repeat-2"):
        response = client.post(
            "/api/chat",
            headers=headers,
            json={"message": "What is a compiler?", "reply_language": "en", "request_id": request_id},
        )
        assert response.status_code == 200

    assert calls == ["What is a compiler?", "What is a compiler?"]
    with SessionLocal() as session:
        qa = session.exec(select(QACache).where(QACache.user_id == user.id)).one()
        assert qa.hits == 2


def test_ai_router_does_not_record_live_or_private_queries(client, monkeypatch):
    create_test_user("unsafe-uid", "unsafe@example.com")
    monkeypatch.setenv("AI_ROUTER_ENABLED", "true")
    monkeypatch.setattr(main_module, "run_text_turn", lambda *args, **kwargs: _provider_answer("This answer should not be cached."))
    headers = auth_headers("unsafe-uid", "unsafe@example.com")

    for message in ("latest IPL score today", "my email is hari@example.com"):
        response = client.post(
            "/api/chat",
            headers=headers,
            json={"message": message, "reply_language": "en"},
        )
        assert response.status_code == 200

    with SessionLocal() as session:
        assert list(session.exec(select(QACache)).all()) == []
        assert list(session.exec(select(GlobalQACache)).all()) == []
