from __future__ import annotations

import json

import app.main as main_module
from app.database import SessionLocal
from app.global_qa_cache import (
    build_global_knowledge_sync_payload,
    lookup_approved_global_cache,
    record_backend_openai_answer,
)
from app.models import GlobalQACache, GlobalQAObservation
from conftest import auth_headers, create_test_user
from sqlmodel import select


def _stub_openai_pipeline(monkeypatch, calls: list[str]):
    monkeypatch.setattr(
        main_module,
        "run_orchestrator",
        lambda client, text: {
            "intent": "GENERAL",
            "priority": "low",
            "confidence": 1.0,
            "matched_keyword": "",
        },
    )

    def fake_pipeline(session, user_id, message, reply_language=None):
        calls.append(message)
        return {
            "remodeled_english": f"Educational answer about {message}.",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
            "route_taken": "full_pipeline",
            "predicted_label": "assistant",
            "direct_answer_source": "backend_openai",
            "direct_answer_confidence": "1.0000",
            "cache_hit": "false",
            "model_used": "cheap-test-model",
            "model_tier": "cheap",
            "model_reason": "test",
        }

    monkeypatch.setattr(main_module, "_run_agentic_or_pipeline", fake_pipeline)
    monkeypatch.setattr(
        main_module,
        "_metadata_for_item",
        lambda session, user_id, text, fallback_details: {
            "intent": "assistant",
            "category": "Other",
            "datetime": None,
            "title": "Assistant",
            "details": fallback_details,
        },
    )


def test_repeated_unknown_questions_promote_and_then_hit_global_cache(client, monkeypatch):
    calls: list[str] = []
    _stub_openai_pipeline(monkeypatch, calls)

    user1 = create_test_user("uid-1", "u1@example.com")
    res1 = client.post(
        "/api/chat",
        headers=auth_headers("uid-1", "u1@example.com"),
        json={"message": "What is a compiler?", "reply_language": "en", "request_id": "r1"},
    )
    assert res1.status_code == 200
    assert res1.json()["pipeline"]["route_taken"] == "full_pipeline"
    assert calls == ["What is a compiler?"]

    with SessionLocal() as session:
        candidates = list(session.exec(select(GlobalQACache)).all())
        observations = list(session.exec(select(GlobalQAObservation)).all())
        assert len(candidates) == 1
        assert candidates[0].status == "candidate"
        assert candidates[0].hit_count == 1
        assert candidates[0].distinct_user_count == 1
        assert len(observations) == 1
        assert observations[0].user_id_hash
        assert observations[0].user_id_hash != str(user1.id)

    create_test_user("uid-2", "u2@example.com")
    res2 = client.post(
        "/api/chat",
        headers=auth_headers("uid-2", "u2@example.com"),
        json={"message": "Explain compiler", "reply_language": "en", "request_id": "r2"},
    )
    assert res2.status_code == 200
    assert res2.json()["pipeline"]["route_taken"] == "full_pipeline"
    assert calls == ["What is a compiler?", "Explain compiler"]

    with SessionLocal() as session:
        candidate = session.exec(select(GlobalQACache)).one()
        assert candidate.status == "approved"
        assert candidate.distinct_user_count == 2
        assert candidate.observed_question_count == 2

    create_test_user("uid-3", "u3@example.com")
    res3 = client.post(
        "/api/chat",
        headers=auth_headers("uid-3", "u3@example.com"),
        json={"message": "Tell me about compilers", "reply_language": "en", "request_id": "r3"},
    )
    assert res3.status_code == 200
    payload = res3.json()
    assert payload["pipeline"]["route_taken"] == "global_knowledge_cache"
    assert payload["pipeline"]["direct_answer_source"] == "global_qa_cache"
    assert payload["pipeline"]["cache_hit"] == "true"
    assert calls == ["What is a compiler?", "Explain compiler"]


def test_live_current_question_is_not_cached_or_served(monkeypatch):
    with SessionLocal() as session:
        result = record_backend_openai_answer(
            session,
            user_id=1,
            question="latest IPL score today",
            answer="This would be live data.",
            model_used="cheap-test-model",
        )
        assert result["skipped"] is True
        session.add(
            GlobalQACache(
                canonical_question="latest IPL score today",
                normalized_question="latest ipl score today",
                answer="Stale score",
                answer_language="en",
                topic="ipl",
                status="approved",
                hit_count=2,
                distinct_user_count=2,
                observed_question_count=2,
                source_question_hashes_json=json.dumps([]),
                answer_hash="hash",
                embedding_json="[]",
                embedding_norm=0,
                confidence=1,
                safety_label="general",
            )
        )
        session.commit()
        assert lookup_approved_global_cache(session, "latest IPL score today", "en") is None


def test_private_and_personalized_advice_questions_are_not_cached():
    with SessionLocal() as session:
        private = record_backend_openai_answer(
            session,
            user_id=1,
            question="My phone number is 9876543210, what should I do?",
            answer="Please do not share personal phone numbers.",
            model_used="cheap-test-model",
        )
        medical = record_backend_openai_answer(
            session,
            user_id=2,
            question="Should I take this medicine for my fistula pain?",
            answer="Ask a doctor before taking medication.",
            model_used="cheap-test-model",
        )
        assert private["skipped"] is True
        assert medical["skipped"] is True
        assert list(session.exec(select(GlobalQACache)).all()) == []


def test_global_knowledge_sync_returns_only_approved_safe_entries(client):
    create_test_user("sync-uid", "sync@example.com")
    with SessionLocal() as session:
        record_backend_openai_answer(session, 1, "What is photosynthesis?", "Photosynthesis is how plants make food.", "cheap-test-model")
        record_backend_openai_answer(session, 2, "Explain photosynthesis", "Photosynthesis is how plants make food.", "cheap-test-model")

    response = client.get(
        "/api/global-knowledge/sync?limit=250",
        headers=auth_headers("sync-uid", "sync@example.com"),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["count"] == 1
    assert payload["entries"][0]["answer"] == "Photosynthesis is how plants make food."
    assert payload["entries"][0]["embeddingKind"] == "token_hash_v1"


def test_similar_questions_with_similar_answers_promote():
    with SessionLocal() as session:
        first = record_backend_openai_answer(
            session,
            user_id=1,
            question="What is a binary tree?",
            answer="A binary tree is a tree data structure where each node has at most two children.",
            model_used="cheap-test-model",
        )
        second = record_backend_openai_answer(
            session,
            user_id=2,
            question="Explain binary trees",
            answer="A binary tree is a data structure whose nodes have no more than two children.",
            model_used="cheap-test-model",
        )
        assert first["status"] == "candidate"
        assert second["promoted"] is True
        candidate = session.exec(select(GlobalQACache)).one()
        assert candidate.status == "approved"


def test_similar_questions_with_conflicting_answers_do_not_promote():
    with SessionLocal() as session:
        record_backend_openai_answer(
            session,
            user_id=1,
            question="What is a compiler?",
            answer="A compiler translates source code into another form before execution.",
            model_used="cheap-test-model",
        )
        second = record_backend_openai_answer(
            session,
            user_id=2,
            question="Explain compiler",
            answer="A compiler is a hardware device used to cool a computer.",
            model_used="cheap-test-model",
        )
        assert second["promoted"] is False
        candidate = session.exec(select(GlobalQACache)).one()
        assert candidate.status == "candidate"
        observations = list(session.exec(select(GlobalQAObservation)).all())
        assert len(observations) == 2
        assert any(json.loads(row.conflicting_answer_hashes_json or "[]") for row in observations)


def test_approved_answer_is_not_overwritten_by_later_different_answer():
    with SessionLocal() as session:
        record_backend_openai_answer(
            session,
            user_id=1,
            question="What is photosynthesis?",
            answer="Photosynthesis is how plants make food from light, water, and carbon dioxide.",
            model_used="cheap-test-model",
        )
        record_backend_openai_answer(
            session,
            user_id=2,
            question="Explain photosynthesis",
            answer="Photosynthesis is how plants make food from light, water, and carbon dioxide.",
            model_used="cheap-test-model",
        )
        approved = session.exec(select(GlobalQACache)).one()
        assert approved.status == "approved"
        original_answer = approved.answer
        original_hash = approved.answer_hash

        record_backend_openai_answer(
            session,
            user_id=3,
            question="Tell me about photosynthesis",
            answer="Photosynthesis is a sports tournament played indoors.",
            model_used="cheap-test-model",
        )
        refreshed = session.get(GlobalQACache, approved.id)
        assert refreshed is not None
        assert refreshed.status == "approved"
        assert refreshed.answer == original_answer
        assert refreshed.answer_hash == original_hash


def test_private_data_bypass_and_sync_safety():
    with SessionLocal() as session:
        private = record_backend_openai_answer(
            session,
            user_id=1,
            question="My email is person@example.com and my phone is 9876543210, what should I do?",
            answer="Avoid sharing private contact details.",
            model_used="cheap-test-model",
        )
        salary = record_backend_openai_answer(
            session,
            user_id=2,
            question="My salary is 20 LPA, should I take this loan?",
            answer="Consider talking to a financial advisor.",
            model_used="cheap-test-model",
        )
        assert private["skipped"] is True
        assert salary["skipped"] is True

        session.add(
            GlobalQACache(
                canonical_question="My phone is [REDACTED_PHONE]",
                normalized_question="my phone is 9876543210",
                answer="Unsafe stale answer",
                answer_language="en",
                topic="phone",
                status="approved",
                hit_count=2,
                distinct_user_count=2,
                observed_question_count=2,
                source_question_hashes_json=json.dumps([]),
                answer_hash="unsafe",
                embedding_json="[]",
                embedding_norm=0,
                confidence=1,
                safety_label="general",
            )
        )
        session.commit()

        payload = build_global_knowledge_sync_payload(session)
        assert payload["count"] == 0
        assert payload["entries"] == []
