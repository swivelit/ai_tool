from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import app.main as main_module
from app.database import SessionLocal, engine
from app.global_qa_cache import (
    build_global_knowledge_sync_payload,
    embed_question_for_global_cache,
    global_qa_schema_ready,
    lookup_approved_global_cache,
    normalize_question,
    record_backend_openai_answer,
    record_global_qa_tombstone,
)
from app.models import GlobalQACache, GlobalQAObservation, GlobalQATombstone
from conftest import auth_headers, create_test_user
from sqlalchemy import text
from sqlmodel import SQLModel, select


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


def test_expanded_live_market_weather_recommendation_questions_bypass_cache():
    blocked_questions = [
        "weather tomorrow",
        "gold rate today",
        "petrol price nearby",
        "USD INR exchange rate",
        "best phone deal near me",
        "yesterday match result",
        "stock price forecast",
    ]
    with SessionLocal() as session:
        for question in blocked_questions:
            result = record_backend_openai_answer(
                session,
                user_id=1,
                question=question,
                answer="This answer should not be globally cached.",
                model_used="cheap-test-model",
            )
            assert result["skipped"] is True

        educational = record_backend_openai_answer(
            session,
            user_id=1,
            question="What is photosynthesis?",
            answer="Photosynthesis is how plants make food from light, water, and carbon dioxide.",
            model_used="cheap-test-model",
        )
        assert educational["ok"] is True

        session.add(
            GlobalQACache(
                canonical_question="weather tomorrow",
                normalized_question="weather tomorrow",
                answer="Stale weather.",
                answer_language="en",
                topic="weather",
                status="approved",
                hit_count=2,
                distinct_user_count=2,
                observed_question_count=2,
                source_question_hashes_json=json.dumps([]),
                answer_hash="weather-hash",
                embedding_json="[]",
                embedding_norm=0,
                confidence=1,
                safety_label="general",
            )
        )
        session.commit()
        assert lookup_approved_global_cache(session, "weather tomorrow", "en") is None


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
    assert payload["hasMore"] is False
    assert payload["revokedIds"] == []


def test_approved_global_cache_hit_skips_openai_orchestrator(client, monkeypatch):
    create_test_user("hit-uid", "hit@example.com")
    question = "What is a compiler?"
    embedding, norm = embed_question_for_global_cache(normalize_question(question))
    with SessionLocal() as session:
        session.add(
            GlobalQACache(
                canonical_question=question,
                normalized_question=normalize_question(question),
                answer="A compiler translates source code.",
                answer_language="en",
                topic="compiler",
                status="approved",
                hit_count=2,
                distinct_user_count=2,
                observed_question_count=2,
                source_question_hashes_json=json.dumps([]),
                answer_hash="compiler-hash",
                embedding_json=json.dumps(embedding),
                embedding_norm=norm,
                confidence=0.95,
                safety_label="general",
                expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            )
        )
        session.commit()

    orchestrator_calls: list[str] = []

    def fail_orchestrator(client_arg, text):
        orchestrator_calls.append(text)
        raise AssertionError("full OpenAI orchestrator must not run for global cache hits")

    monkeypatch.setattr(main_module, "run_orchestrator", fail_orchestrator)
    monkeypatch.setattr(
        main_module,
        "_run_agentic_or_pipeline",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("pipeline must not run")),
    )

    response = client.post(
        "/api/chat",
        headers=auth_headers("hit-uid", "hit@example.com"),
        json={"message": "Explain compiler", "reply_language": "en", "request_id": "hit-1"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["pipeline"]["route_taken"] == "global_knowledge_cache"
    assert payload["pipeline"]["direct_answer_source"] == "global_qa_cache"
    assert orchestrator_calls == []


def test_approved_global_cache_hit_does_not_change_updated_at():
    question = "What is a compiler?"
    embedding, norm = embed_question_for_global_cache(normalize_question(question))
    created = datetime(2026, 5, 1, 12, 0, 0)
    with SessionLocal() as session:
        row = GlobalQACache(
            canonical_question=question,
            normalized_question=normalize_question(question),
            answer="A compiler translates source code.",
            answer_language="en",
            topic="compiler",
            status="approved",
            hit_count=2,
            distinct_user_count=2,
            observed_question_count=2,
            source_question_hashes_json=json.dumps([]),
            answer_hash="compiler-hash",
            embedding_json=json.dumps(embedding),
            embedding_norm=norm,
            confidence=0.95,
            safety_label="general",
            created_at=created,
            updated_at=created,
            last_seen_at=created,
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
        )
        session.add(row)
        session.commit()
        session.refresh(row)

        hit = lookup_approved_global_cache(session, "Explain compiler", "en")
        assert hit is not None

        refreshed = session.get(GlobalQACache, row.id)
        assert refreshed is not None
        assert refreshed.hit_count == 3
        assert refreshed.last_seen_at != created
        assert refreshed.updated_at == created


def test_global_knowledge_sync_paginates_without_missing_rows():
    base = datetime(2026, 5, 14, 0, 0, tzinfo=timezone.utc)
    expires_at = datetime.now(timezone.utc) + timedelta(days=30)
    with SessionLocal() as session:
        for index in range(600):
            session.add(
                GlobalQACache(
                    canonical_question=f"What is sync concept {index}?",
                    normalized_question=normalize_question(f"What is sync concept {index}?"),
                    answer=f"Sync concept {index} answer.",
                    answer_language="en",
                    topic="sync",
                    status="approved",
                    hit_count=2,
                    distinct_user_count=2,
                    observed_question_count=2,
                    source_question_hashes_json=json.dumps([]),
                    answer_hash=f"hash-{index}",
                    embedding_json="[]",
                    embedding_norm=0,
                    confidence=0.95,
                    safety_label="general",
                    updated_at=base + timedelta(seconds=index),
                    expires_at=expires_at,
                )
            )
        session.commit()

        seen: list[int] = []
        since = None
        after_id = None
        pages = 0
        while True:
            payload = build_global_knowledge_sync_payload(session, since=since, after_id=after_id, limit=250)
            pages += 1
            seen.extend(int(entry["id"]) for entry in payload["entries"])
            since = payload["nextSince"]
            after_id = payload["nextAfterId"]
            if not payload["hasMore"]:
                break

        assert pages == 3
        assert len(seen) == 600
        assert len(set(seen)) == 600


def test_global_knowledge_sync_revokes_rejected_rows():
    base = datetime(2026, 5, 14, 0, 0, tzinfo=timezone.utc)
    expires_at = datetime.now(timezone.utc) + timedelta(days=30)
    with SessionLocal() as session:
        row = GlobalQACache(
            canonical_question="What is a queue?",
            normalized_question="what is queue",
            answer="A queue is a first-in, first-out data structure.",
            answer_language="en",
            topic="queue",
            status="approved",
            hit_count=2,
            distinct_user_count=2,
            observed_question_count=2,
            source_question_hashes_json=json.dumps([]),
            answer_hash="queue-hash",
            embedding_json="[]",
            embedding_norm=0,
            confidence=0.95,
            safety_label="general",
            updated_at=base,
            expires_at=expires_at,
        )
        session.add(row)
        session.commit()
        session.refresh(row)

        first = build_global_knowledge_sync_payload(session, limit=250)
        assert [entry["id"] for entry in first["entries"]] == [row.id]

        row.status = "rejected"
        row.updated_at = base + timedelta(seconds=1)
        session.add(row)
        session.commit()

        second = build_global_knowledge_sync_payload(
            session,
            since=first["nextSince"],
            after_id=first["nextAfterId"],
            limit=250,
        )
        assert second["entries"] == []
        assert second["revokedIds"] == [row.id]


def test_global_knowledge_sync_revokes_tombstoned_deleted_rows():
    expires_at = datetime.now(timezone.utc) + timedelta(days=30)
    with SessionLocal() as session:
        row = GlobalQACache(
            canonical_question="What is a heap?",
            normalized_question="what is heap",
            answer="A heap is a tree-based data structure.",
            answer_language="en",
            topic="heap",
            status="approved",
            hit_count=2,
            distinct_user_count=2,
            observed_question_count=2,
            source_question_hashes_json=json.dumps([]),
            answer_hash="heap-hash",
            embedding_json="[]",
            embedding_norm=0,
            confidence=0.95,
            safety_label="general",
            expires_at=expires_at,
        )
        session.add(row)
        session.commit()
        session.refresh(row)

        first = build_global_knowledge_sync_payload(session, limit=250)
        assert [entry["id"] for entry in first["entries"]] == [row.id]

        deleted_id = int(row.id)
        record_global_qa_tombstone(session, deleted_id, reason="admin_deleted")
        session.delete(row)
        session.commit()

        second = build_global_knowledge_sync_payload(
            session,
            since=first["nextSince"],
            after_id=first["nextAfterId"],
            limit=250,
        )
        assert second["entries"] == []
        assert second["revokedIds"] == [deleted_id]


def test_global_knowledge_sync_skips_corrupt_embedding_rows(caplog):
    with SessionLocal() as session:
        row = GlobalQACache(
            canonical_question="What is a stack?",
            normalized_question="what is stack",
            answer="A stack is a last-in, first-out data structure.",
            answer_language="en",
            topic="stack",
            status="approved",
            hit_count=2,
            distinct_user_count=2,
            observed_question_count=2,
            source_question_hashes_json=json.dumps([]),
            answer_hash="stack-hash",
            embedding_json="{not-json",
            embedding_norm=0,
            confidence=0.95,
            safety_label="general",
        )
        session.add(row)
        session.commit()
        session.refresh(row)

        payload = build_global_knowledge_sync_payload(session, limit=250)

        assert payload["entries"] == []
        assert payload["revokedIds"] == [row.id]
        assert "global_knowledge_sync_skipped_corrupt_entry" in caplog.text


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


def test_alias_lookup_matches_safe_abbreviation_variants():
    with SessionLocal() as session:
        record_backend_openai_answer(
            session,
            user_id=1,
            question="What is IPL?",
            answer="The Indian Premier League is a professional Twenty20 cricket league in India.",
            model_used="cheap-test-model",
        )
        record_backend_openai_answer(
            session,
            user_id=2,
            question="Explain IPL",
            answer="The Indian Premier League is a professional Twenty20 cricket league in India.",
            model_used="cheap-test-model",
        )
        approved = session.exec(select(GlobalQACache)).one()
        assert approved.status == "approved"

        hit = lookup_approved_global_cache(session, "Tell me about Indian Premier League", "en")
        assert hit is not None
        assert hit["id"] == approved.id

        assert lookup_approved_global_cache(session, "latest Indian Premier League score", "en") is None


def test_private_variants_are_not_stored_or_synced():
    with SessionLocal() as session:
        private = record_backend_openai_answer(
            session,
            user_id=1,
            question="My email is person@example.com, what is AI?",
            answer="AI means artificial intelligence.",
            model_used="cheap-test-model",
        )
        assert private["skipped"] is True
        assert list(session.exec(select(GlobalQACache)).all()) == []

        row = GlobalQACache(
            canonical_question="What is AI?",
            normalized_question="what is ai",
            answer="AI means artificial intelligence.",
            answer_language="en",
            topic="ai",
            status="approved",
            hit_count=2,
            distinct_user_count=2,
            observed_question_count=2,
            source_question_hashes_json=json.dumps([]),
            observed_safe_questions_json=json.dumps(["what is ai", "my email is person@example.com"]),
            aliases_json=json.dumps(["what is artificial intelligence", "person@example.com artificial intelligence"]),
            answer_hash="ai-hash",
            embedding_json="[]",
            embedding_norm=0,
            confidence=0.95,
            safety_label="general",
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
        )
        session.add(row)
        session.commit()

        payload = build_global_knowledge_sync_payload(session)
        entry = payload["entries"][0]
        serialized = json.dumps(entry)
        assert "person@example.com" not in serialized
        assert "what is ai" in entry["observedSafeQuestions"]
        assert "what is artificial intelligence" in entry["aliases"]


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


def _drop_global_qa_schema_for_test():
    with SessionLocal() as session:
        for table_name in [
            "global_qa_observation",
            "global_qa_tombstone",
            "global_qa_cache",
            "openai_usage_log",
        ]:
            session.exec(text(f"DROP TABLE IF EXISTS {table_name}"))
        session.commit()


def _restore_global_qa_schema_for_test():
    SQLModel.metadata.create_all(engine)


def test_global_knowledge_sync_missing_schema_returns_safe_payload(client):
    create_test_user("sync-missing-uid", "sync-missing@example.com")
    _drop_global_qa_schema_for_test()
    try:
        response = client.get(
            "/api/global-knowledge/sync?limit=250",
            headers=auth_headers("sync-missing-uid", "sync-missing@example.com"),
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["ok"] is False
        assert payload["schemaReady"] is False
        assert payload["entries"] == []
        assert payload["revokedIds"] == []
        assert payload["hasMore"] is False
        assert payload["count"] == 0
        assert payload["error"] == "global_qa_schema_not_ready"
        assert "global_qa_cache" in payload["missingTables"]
    finally:
        _restore_global_qa_schema_for_test()


def test_lookup_approved_global_cache_returns_none_when_schema_missing(caplog):
    _drop_global_qa_schema_for_test()
    try:
        with SessionLocal() as session:
            assert global_qa_schema_ready(session)["ok"] is False
            assert lookup_approved_global_cache(session, "What is photosynthesis?", "en") is None
        assert "global_cache_schema_not_ready" in caplog.text
    finally:
        _restore_global_qa_schema_for_test()


def test_record_backend_openai_answer_skips_when_schema_missing(caplog):
    _drop_global_qa_schema_for_test()
    try:
        with SessionLocal() as session:
            result = record_backend_openai_answer(
                session,
                user_id=1,
                question="What is photosynthesis?",
                answer="Photosynthesis is how plants make food.",
                model_used="cheap-test-model",
            )
        assert result["skipped"] is True
        assert result["reason"] == "global_qa_schema_not_ready"
        assert "global_cache_record_skipped_schema_not_ready" in caplog.text
    finally:
        _restore_global_qa_schema_for_test()
