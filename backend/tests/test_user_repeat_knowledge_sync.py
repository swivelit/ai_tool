from __future__ import annotations

import json
from datetime import timedelta

from app.database import SessionLocal
from app.global_qa_cache import (
    GLOBAL_QA_EMBEDDING_KIND,
    answer_hash,
    build_global_knowledge_sync_payload,
    embed_question_for_global_cache,
    lookup_approved_global_cache,
    normalize_question,
    record_backend_openai_answer,
)
from app.models import GlobalQACache, QACache
from app.time_utils import utc_now
from conftest import create_test_user


def _qa_answer_payload(answer: str, route: str = "openai_general") -> str:
    return json.dumps(
        {
            "pipeline": {
                "route_taken": route,
                "direct_answer_source": "openai",
                "cache_hit": "false",
                "risk_level": "low",
                "remodeled_english": answer,
                "raw_english": answer,
            },
            "meta": {
                "intent": "assistant",
                "category": "Other",
                "details": answer,
            },
        },
        ensure_ascii=False,
    )


def _insert_user_qa(user_id: int, question: str, answer: str, *, hits: int = 2, days_old: int = 0, route: str = "openai_general") -> None:
    with SessionLocal() as session:
        session.add(
            QACache(
                user_id=user_id,
                question=question,
                answer=_qa_answer_payload(answer, route=route),
                hits=hits,
                updated_at=utc_now() - timedelta(days=days_old),
            )
        )
        session.commit()


def _insert_global_entry(question: str, answer: str) -> None:
    normalized = normalize_question(question)
    embedding, embedding_norm = embed_question_for_global_cache(normalized)
    now = utc_now()
    with SessionLocal() as session:
        session.add(
            GlobalQACache(
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
                aliases_json=json.dumps([]),
                answer_hash=answer_hash(answer),
                embedding_json=json.dumps(embedding),
                embedding_kind=GLOBAL_QA_EMBEDDING_KIND,
                embedding_norm=embedding_norm,
                confidence=0.95,
                safety_label="general",
                expires_at=now + timedelta(days=30),
            )
        )
        session.commit()


def test_same_user_receives_repeated_safe_qa_entry():
    user = create_test_user("sync-user", "sync-user@example.com")
    _insert_user_qa(
        int(user.id),
        "What is Spitzola?",
        "Spitzola is a stable fictional test answer.",
    )

    with SessionLocal() as session:
        payload = build_global_knowledge_sync_payload(session, user_id=int(user.id))

    assert payload["ok"] is True
    assert payload["entries"] == []
    assert len(payload["userEntries"]) == 1
    entry = payload["userEntries"][0]
    assert entry["id"].startswith("user:")
    assert entry["scope"] == "user"
    assert entry["answer"] == "Spitzola is a stable fictional test answer."
    assert entry["embeddingKind"] == "token_hash_v1"
    assert entry["source"]["kind"] == "user_qa_cache"


def test_other_user_does_not_receive_user_scoped_qa_entry():
    owner = create_test_user("owner", "owner@example.com")
    other = create_test_user("other", "other@example.com")
    _insert_user_qa(
        int(owner.id),
        "What is Spitzola?",
        "Spitzola is a stable fictional test answer.",
    )

    with SessionLocal() as session:
        payload = build_global_knowledge_sync_payload(session, user_id=int(other.id))

    assert payload["userEntries"] == []


def test_unsafe_live_and_old_user_entries_are_excluded():
    user = create_test_user("unsafe-sync", "unsafe-sync@example.com")
    _insert_user_qa(int(user.id), "latest IPL score today", "Stale score.", hits=2)
    _insert_user_qa(int(user.id), "my email is hari@example.com", "Private answer.", hits=2)
    _insert_user_qa(int(user.id), "What is an old concept?", "Old answer.", hits=2, days_old=45)
    _insert_user_qa(int(user.id), "Create reminder", "Reminder created.", hits=2, route="reminder_create")

    with SessionLocal() as session:
        payload = build_global_knowledge_sync_payload(session, user_id=int(user.id))

    assert payload["userEntries"] == []


def test_global_entries_still_sync_with_user_entries_shape():
    user = create_test_user("global-sync", "global-sync@example.com")
    _insert_global_entry(
        "What is a compiler?",
        "A compiler translates source code into another executable form.",
    )

    with SessionLocal() as session:
        payload = build_global_knowledge_sync_payload(session, user_id=int(user.id))

    assert payload["ok"] is True
    assert len(payload["entries"]) == 1
    assert payload["entries"][0]["canonicalQuestion"] == "What is a compiler?"
    assert payload["userEntries"] == []
    assert "userEntries" in payload
    assert "revokedIds" in payload


def test_provider_answer_creates_user_scoped_global_cache_and_second_user_hit():
    user = create_test_user("provider-repeat", "provider-repeat@example.com")
    with SessionLocal() as session:
        result = record_backend_openai_answer(
            session,
            int(user.id),
            "What is a trie?",
            "A trie is a tree data structure for prefix lookup.",
            "cheap-test-model",
        )
        assert result["ok"] is True
        assert result["user_candidate_id"] is not None

        same_user_hit = lookup_approved_global_cache(
            session,
            "Explain tries",
            "en",
            user_id=int(user.id),
        )
        other_user_hit = lookup_approved_global_cache(
            session,
            "Explain tries",
            "en",
            user_id=9999,
        )

    assert same_user_hit is not None
    assert same_user_hit["scope"] == "user"
    assert same_user_hit["cache_hit_source"] == "L2_user_global_qa"
    assert other_user_hit is None


def test_sync_includes_user_scoped_global_qa_entries():
    user = create_test_user("provider-sync", "provider-sync@example.com")
    with SessionLocal() as session:
        record_backend_openai_answer(
            session,
            int(user.id),
            "What is a trie?",
            "A trie is a tree data structure for prefix lookup.",
            "cheap-test-model",
        )
        payload = build_global_knowledge_sync_payload(session, user_id=int(user.id))

    assert payload["entries"] == []
    assert len(payload["userEntries"]) == 1
    entry = payload["userEntries"][0]
    assert entry["id"].startswith("user-global:")
    assert entry["scope"] == "user"
    assert entry["embeddingKind"] == "token_hash_v1"
    assert entry["tokenHashEmbeddingKind"] == "token_hash_v1"
