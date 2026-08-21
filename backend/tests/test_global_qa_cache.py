from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

import app.main as main_module
from app.database import SessionLocal, engine
from app.global_qa_cache import (
    backfill_global_qa_embeddings,
    build_global_knowledge_sync_payload,
    embed_question_for_global_cache,
    global_qa_schema_ready,
    lookup_approved_global_cache,
    normalize_question,
    record_backend_openai_answer,
    record_global_qa_tombstone,
    _infer_answer_language,
    _row_lookup_safe,
)


@pytest.mark.parametrize("language", ["hi", "bn", "te", "ml", "mr", "tanglish", "en"])
def test_requested_cache_language_is_preserved_without_script_inference(language):
    assert _infer_answer_language("An English answer", language) == language


def test_english_cache_row_does_not_satisfy_known_indic_language():
    row = GlobalQACache(
        status="approved", confidence=0.9, answer="English answer",
        answer_language="en", safety_label="general", expires_at=None,
        scope="global",
    )
    assert not _row_lookup_safe(row, "same question", "hi", utc_now(), user_hash=None)


@pytest.mark.parametrize("language, answer", [
    ("en", "Photosynthesis is how plants convert light, water, and carbon dioxide into food."),
    ("hi", "प्रकाश संश्लेषण में पौधे प्रकाश, पानी और कार्बन डाइऑक्साइड से भोजन बनाते हैं।"),
    ("ml", "പ്രകാശസംശ്ലേഷണത്തിൽ സസ്യങ്ങൾ പ്രകാശവും വെള്ളവും കാർബൺ ഡയോക്സൈഡും ഉപയോഗിച്ച് ഭക്ഷണം നിർമ്മിക്കുന്നു."),
    ("bn", "সালোকসংশ্লেষণে উদ্ভিদ আলো, জল ও কার্বন ডাই-অক্সাইড ব্যবহার করে খাদ্য তৈরি করে।"),
    ("tanglish", "Photosynthesis-la plants light, water, carbon dioxide use panni food create pannum."),
])
def test_global_candidates_are_partitioned_by_requested_answer_language(language, answer):
    question = "What is photosynthesis in a language-isolated cache?"
    with SessionLocal() as session:
        record_backend_openai_answer(
            session, 901, question, answer, "test-model", reply_language=language
        )
        rows = list(session.exec(select(GlobalQACache).where(
            GlobalQACache.scope == "global",
            GlobalQACache.canonical_question == question,
        )).all())
        assert len(rows) == 1
        assert rows[0].answer_language == language


def test_hindi_observation_does_not_mutate_english_candidate():
    question = "What is photosynthesis in a language-isolated observation?"
    with SessionLocal() as session:
        record_backend_openai_answer(
            session, 902, question,
            "Photosynthesis is how plants convert light, water, and carbon dioxide into food.",
            "test-model", reply_language="en"
        )
        record_backend_openai_answer(
            session, 903, question,
            "प्रकाश संश्लेषण में पौधे प्रकाश, पानी और कार्बन डाइऑक्साइड से भोजन बनाते हैं।",
            "test-model", reply_language="hi"
        )
        rows = list(session.exec(select(GlobalQACache).where(
            GlobalQACache.scope == "global",
            GlobalQACache.canonical_question == question,
        ).order_by(GlobalQACache.answer_language)).all())
        assert [(row.answer_language, row.answer) for row in rows] == [
            ("en", "Photosynthesis is how plants convert light, water, and carbon dioxide into food."),
            ("hi", "प्रकाश संश्लेषण में पौधे प्रकाश, पानी और कार्बन डाइऑक्साइड से भोजन बनाते हैं।"),
        ]
from app.job_queue import enqueue_global_qa_embedding_backfill
from app.models import GlobalQACache, GlobalQAObservation, GlobalQATombstone, Job
from app.ai.agents.aggregator_reflection_agent import AggregatorReflectionAgent
from app.ai.agents.feedback_quality_agent import FeedbackQualityAgent
from app.ai.agents.live_data_classifier_agent import LiveDataClassifierAgent
from app.ai.agents.web_search_agent import WebSearchAgent
from app.time_utils import utc_now
from conftest import auth_headers, create_test_user
from sqlalchemy import text
from sqlmodel import SQLModel, select
from app.web_api.chat_service import (
    _cache_response, execute_web_turn, prepare_web_turn,
)
from app.web_ai.generation.output_contract import OutputContract


def _stub_openai_pipeline(monkeypatch, calls: list[str]):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "false")
    monkeypatch.setenv("AI_LEGACY_PIPELINE_ENABLED", "true")
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
        global_candidates = [row for row in candidates if row.scope == "global"]
        user_candidates = [row for row in candidates if row.scope == "user"]
        observations = list(session.exec(select(GlobalQAObservation)).all())
        assert len(global_candidates) == 1
        assert len(user_candidates) == 1
        assert user_candidates[0].status == "approved"
        assert global_candidates[0].status == "candidate"
        assert global_candidates[0].hit_count == 1
        assert global_candidates[0].distinct_user_count == 1
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
        candidate = session.exec(select(GlobalQACache).where(
            GlobalQACache.scope == "global"
        )).one()
        assert candidate.status == "approved"
        assert candidate.distinct_user_count == 2
        assert candidate.observed_question_count == 2

    create_test_user("uid-3", "u3@example.com")
    res3 = client.post(
        "/api/chat",
        headers=auth_headers("uid-3", "u3@example.com"),
        json={
            "message": "Tell me about compilers",
            "reply_language": "en",
            "request_id": "r3",
        },
    )
    assert res3.status_code == 200
    payload = res3.json()
    assert payload["pipeline"]["route_taken"] == "global_knowledge_cache"
    assert payload["pipeline"]["direct_answer_source"] == "global_qa_cache"
    assert payload["pipeline"]["cache_hit"] == "true"
    assert calls == ["What is a compiler?", "Explain compiler"]


def test_web_semantic_hit_precedes_chat_provider_invocation(monkeypatch):
    monkeypatch.setenv("GLOBAL_QA_SEMANTIC_ENABLED", "true")
    monkeypatch.setenv("WEB_CACHE_BEFORE_BILLING_ENABLED", "true")
    monkeypatch.setattr(
        "app.global_qa_cache.cached_text_embedding",
        lambda *_args, **_kwargs: [1.0, 0.0],
    )
    user = create_test_user("semantic-web", "semantic-web@example.com")
    compatibility = "semantic-web-compatible"
    with SessionLocal() as session:
        row = GlobalQACache(
            canonical_question="What is a FIFO queue?",
            normalized_question="what is a fifo queue",
            answer="FIFO serves the oldest queued item first.",
            answer_language="en", scope="global", status="approved",
            hit_count=2, distinct_user_count=2, observed_question_count=2,
            source_question_hashes_json=json.dumps([compatibility]),
            answer_hash="semantic-web",
            embedding_json="[1,0]", embedding_kind="openai:test",
            embedding_norm=1.0, real_embedding_json="[1,0]",
            real_embedding_norm=1.0, real_embedding_kind="openai:test",
            confidence=0.95, safety_label="general",
            expires_at=utc_now() + timedelta(days=1),
        )
        session.add(row); session.commit(); row_id = int(row.id)

    class Store:
        def search(self, *_args, **_kwargs):
            return [{"source_id": str(row_id), "score_semantic": 1.0}]

    monkeypatch.setattr("app.global_qa_cache.get_vector_store", lambda: Store())
    with SessionLocal() as session:
        semantic = lookup_approved_global_cache(
            session, "Explain first-in-first-out ordering", "en",
            user_id=int(user.id),
        )
    assert semantic and semantic["cache_hit_kind"] == "semantic"
    cached_response = _cache_response(
        int(user.id), "Explain first-in-first-out ordering", "en",
        output_contract=OutputContract(), answer_class="normal",
        cache_compatibility_hash=compatibility,
    )
    assert cached_response is not None
    assert cached_response.raw["cache_hit_kind"] == "semantic"
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *_args, **_kwargs: cached_response,
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.create_usage_reservation",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("semantic hit must precede reservation")
        ),
    )
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Explain first-in-first-out ordering",
        request_id="semantic-web-request", thread_id=None, reply_language="en",
    )

    class ProviderSpy:
        def complete(self, *_args, **_kwargs):
            raise AssertionError("semantic cache hit must skip chat generation")

        stream_complete = complete

    completed = execute_web_turn(
        prepared, providers={"openai": ProviderSpy(), "sarvam": ProviderSpy()}
    )
    assert completed.response.provider == "cache"
    assert completed.response.raw["cache_hit_kind"] == "semantic"


def test_global_embedding_backfill_job_is_bounded_and_deduplicated(monkeypatch):
    monkeypatch.setenv("GLOBAL_QA_SEMANTIC_ENABLED", "true")
    with SessionLocal() as session:
        first = enqueue_global_qa_embedding_backfill(session, batch_size=2)
        second = enqueue_global_qa_embedding_backfill(session, batch_size=50)
        active = session.exec(select(Job).where(
            Job.job_type == "global_qa_embedding_backfill"
        )).all()
    assert first.id == second.id
    assert len(active) == 1

    upserts = []
    monkeypatch.setattr(
        "app.global_qa_cache.embedding_bundle_for_global_cache",
        lambda _text: {
            "embedding": [1.0, 0.0], "embedding_norm": 1.0,
            "embedding_kind": "openai:test",
            "token_hash_embedding": [1.0, 0.0],
            "token_hash_embedding_norm": 1.0,
            "real_embedding": [1.0, 0.0],
            "real_embedding_norm": 1.0,
            "real_embedding_kind": "openai:test",
        },
    )
    monkeypatch.setattr(
        "app.global_qa_cache._upsert_vector_for_row",
        lambda _session, row: upserts.append(row.id),
    )
    with SessionLocal() as session:
        for index in range(3):
            session.add(GlobalQACache(
                canonical_question=f"Bounded {index}",
                normalized_question=f"bounded {index}",
                answer="A durable approved answer.",
                answer_language="en", scope="global", status="approved",
                hit_count=2, distinct_user_count=2,
                observed_question_count=2, source_question_hashes_json="[]",
                answer_hash=f"bounded-{index}", confidence=0.9,
                safety_label="general",
            ))
        session.commit()
        result = backfill_global_qa_embeddings(session, batch_size=2)
    assert result["scanned"] == 2
    assert result["has_more"] is True
    assert len(upserts) == 2


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
        "Do you know about the new election details?",
        "election results",
        "who won the election?",
        "latest government update",
        "prime minister news",
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


def test_static_educational_questions_remain_cacheable():
    stable_questions = [
        (
            "What is IPL?",
            "The Indian Premier League is a professional T20 cricket league in India.",
        ),
        (
            "What is photosynthesis?",
            "Photosynthesis is how plants make food from light, water, and carbon dioxide.",
        ),
        (
            "What is a compiler?",
            "A compiler translates source code into another form before execution.",
        ),
    ]
    with SessionLocal() as session:
        for index, (question, answer) in enumerate(stable_questions, start=1):
            result = record_backend_openai_answer(
                session,
                user_id=index,
                question=question,
                answer=answer,
                model_used="cheap-test-model",
            )
            assert result["ok"] is True
            assert result.get("skipped") is not True


def test_political_current_questions_are_not_served_from_stale_global_cache():
    with SessionLocal() as session:
        session.add(
            GlobalQACache(
                canonical_question="election results",
                normalized_question="election results",
                answer="Stale election answer.",
                answer_language="en",
                topic="election",
                status="approved",
                hit_count=2,
                distinct_user_count=2,
                observed_question_count=2,
                source_question_hashes_json=json.dumps([]),
                answer_hash="election-hash",
                embedding_json="[]",
                embedding_norm=0,
                confidence=1,
                safety_label="general",
            )
        )
        session.commit()

        assert lookup_approved_global_cache(session, "new election details", "en") is None
        assert lookup_approved_global_cache(session, "election results", "en") is None
        assert lookup_approved_global_cache(session, "who won the election?", "en") is None


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
        candidate = session.exec(select(GlobalQACache).where(GlobalQACache.scope == "global")).one()
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
        approved = session.exec(select(GlobalQACache).where(GlobalQACache.scope == "global")).one()
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
        candidate = session.exec(select(GlobalQACache).where(GlobalQACache.scope == "global")).one()
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
        approved = session.exec(select(GlobalQACache).where(GlobalQACache.scope == "global")).one()
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


def test_feedback_quality_decrements_confidence_and_tombstones_low_confidence():
    with SessionLocal() as session:
        row = GlobalQACache(
            canonical_question="What is a queue?",
            normalized_question="what is queue",
            answer="A queue is FIFO.",
            answer_language="en",
            topic="queue",
            status="approved",
            hit_count=2,
            distinct_user_count=2,
            observed_question_count=2,
            source_question_hashes_json=json.dumps([]),
            answer_hash="queue-feedback",
            embedding_json="[]",
            embedding_norm=0,
            confidence=0.40,
            safety_label="general",
            expires_at=datetime.now(timezone.utc) + timedelta(days=30),
        )
        session.add(row)
        session.commit()
        session.refresh(row)

        result = FeedbackQualityAgent().apply_negative_feedback(session, row, amount=0.10)
        tombstones = list(session.exec(select(GlobalQATombstone)).all())
        refreshed = session.get(GlobalQACache, row.id)

    assert result.tombstoned is True
    assert refreshed.status == "rejected"
    assert tombstones
    assert tombstones[0].global_cache_id == row.id


def test_live_data_classifier_catches_current_queries_without_overblocking_stable_knowledge():
    agent = LiveDataClassifierAgent()
    live_questions = [
        "who's playing tonight",
        "what's the score",
        "latest election result",
        "who is president now",
        "current price of bitcoin",
    ]
    stable_questions = [
        "what is a compiler",
        "explain photosynthesis",
        "what is section 80c deduction",
    ]

    assert all(agent.classify(question).is_live for question in live_questions)
    assert not any(agent.classify(question).is_live for question in stable_questions)


def test_aggregator_reflection_plans_without_mutating_unless_apply_changes():
    with SessionLocal() as session:
        for index in range(2):
            session.add(
                GlobalQACache(
                    canonical_question=f"What is duplicate {index}?",
                    normalized_question=f"what is duplicate {index}",
                    answer="Duplicate answer.",
                    answer_language="en",
                    topic="duplicate",
                    status="approved",
                    hit_count=2 + index,
                    distinct_user_count=2,
                    observed_question_count=2,
                    source_question_hashes_json=json.dumps([]),
                    answer_hash="duplicate-hash",
                    embedding_json="[]",
                    embedding_norm=0,
                    confidence=0.95,
                    safety_label="general",
                    expires_at=datetime.now(timezone.utc) + timedelta(days=30),
                )
            )
        session.commit()
        result = AggregatorReflectionAgent().run_batch(session)
        rows = list(session.exec(select(GlobalQACache)).all())

    assert result.clustered == 1
    assert result.planned_updates
    assert all(not row.review_notes for row in rows)


def test_web_search_agent_disabled_by_default_and_mocked_wikipedia_enabled(monkeypatch):
    monkeypatch.delenv("ENABLE_WEB_SEARCH_FOR_FREE", raising=False)
    assert WebSearchAgent().search("what is python").reason == "disabled"

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps(
                {
                    "title": "Python",
                    "extract": "Python is a programming language.",
                    "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Python"}},
                }
            ).encode("utf-8")

    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: Response())

    result = WebSearchAgent().search("what is python")

    assert result.enabled is True
    assert result.reason == "wikipedia_summary"
    assert result.results[0]["source"] == "wikipedia"
    assert result.results[0]["url"].startswith("https://en.wikipedia.org/")


def test_owner_memory_questions_never_enter_or_hit_shared_cache(monkeypatch):
    monkeypatch.setenv("GLOBAL_QA_SEMANTIC_ENABLED", "true")
    owner = create_test_user("cache-memory-owner", "cache-memory-owner@example.com")
    other = create_test_user("cache-memory-other", "cache-memory-other@example.com")
    questions = [
        "What reply style do I prefer?",
        "What are my saved preferences?",
        "What did I tell you about my project?",
        "What do you remember about me?",
        "Show my profile and user settings",
    ]
    with SessionLocal() as session:
        for question in questions:
            result = record_backend_openai_answer(
                session,
                int(owner.id),
                question,
                "You prefer concise Tamil-English replies.",
                "test-model",
            )
            assert result["skipped"] is True
        assert session.exec(select(GlobalQACache)).all() == []
        poisoned = GlobalQACache(
            scope="global",
            user_id_hash=None,
            canonical_question="What reply style do I prefer?",
            normalized_question="what reply style do i prefer",
            answer="Owner A private preference",
            answer_language="en",
            status="approved",
            hit_count=5,
            distinct_user_count=5,
            observed_question_count=5,
            source_question_hashes_json="[]",
            answer_hash="private-poison",
            confidence=1.0,
            safety_label="general",
        )
        session.add(poisoned)
        session.commit()
        # The owner-context privacy gate must run before the shared hot-cache
        # adapter (Redis or in-process), exact rows, and semantic fallback.
        monkeypatch.setattr(
            "app.global_qa_cache._lookup_hot_cache",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("private questions must not reach a hot cache")
            ),
        )
        monkeypatch.setattr(
            "app.global_qa_cache._semantic_lookup_after_exact_miss",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("private questions must not reach semantic cache")
            ),
        )
        assert lookup_approved_global_cache(
            session,
            "What reply style do I prefer?",
            "en",
            user_id=int(owner.id),
        ) is None
        assert lookup_approved_global_cache(
            session,
            "What reply style do I prefer?",
            "en",
            user_id=int(other.id),
        ) is None
