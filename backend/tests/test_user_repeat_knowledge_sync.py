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
    record_global_qa_tombstone,
    reset_global_qa_hot_cache_for_tests,
)
from app.models import GlobalQACache, QACache
from app.openai_model_router import stable_user_hash
from app.time_utils import utc_now
from conftest import auth_headers, create_test_user


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


def _insert_global_entry(question: str, answer: str, *, topic: str = "compiler", scope: str = "global", user_id: int | None = None) -> int:
    normalized = normalize_question(question)
    embedding, embedding_norm = embed_question_for_global_cache(normalized)
    now = utc_now()
    with SessionLocal() as session:
        row = GlobalQACache(
                canonical_question=question,
                normalized_question=normalized,
                answer=answer,
                answer_language="en",
                topic=topic,
                scope=scope,
                user_id_hash=stable_user_hash(user_id) if scope == "user" and user_id is not None else None,
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
        session.add(row)
        session.commit()
        session.refresh(row)
        return int(row.id)


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


def test_same_user_lookup_prefers_user_scoped_row_over_global_row():
    user = create_test_user("strict-owner", "strict-owner@example.com")
    _insert_global_entry(
        "What is a trie?",
        "Global trie answer.",
        topic="trie",
    )
    _insert_global_entry(
        "What is a trie?",
        "User trie answer.",
        topic="trie",
        scope="user",
        user_id=int(user.id),
    )

    with SessionLocal() as session:
        hit = lookup_approved_global_cache(session, "What is a trie?", "en", user_id=int(user.id))

    assert hit is not None
    assert hit["scope"] == "user"
    assert hit["answer"] == "User trie answer."
    assert hit["cache_hit_source"] == "L2_user_global_qa"


def test_different_user_does_not_see_another_users_scoped_global_row():
    owner = create_test_user("strict-owner-2", "strict-owner-2@example.com")
    other = create_test_user("strict-other-2", "strict-other-2@example.com")
    _insert_global_entry(
        "What is a skip list?",
        "Owner-only skip list answer.",
        topic="skip",
        scope="user",
        user_id=int(owner.id),
    )

    with SessionLocal() as session:
        hit = lookup_approved_global_cache(session, "What is a skip list?", "en", user_id=int(other.id))

    assert hit is None


def test_global_fallback_still_works_after_user_scope_miss():
    user = create_test_user("strict-global", "strict-global@example.com")
    _insert_global_entry(
        "What is section 80c deduction?",
        "Section 80C is an Indian income-tax deduction category.",
        topic="tax",
    )

    with SessionLocal() as session:
        hit = lookup_approved_global_cache(session, "What is section 80c deduction?", "en", user_id=int(user.id))

    assert hit is not None
    assert hit["scope"] == "global"
    assert hit["cache_hit_source"] == "L3_global_qa"


def test_hot_cache_user_hit_is_returned_before_sql_scoring():
    reset_global_qa_hot_cache_for_tests()
    user = create_test_user("strict-hot", "strict-hot@example.com")
    with SessionLocal() as session:
        result = record_backend_openai_answer(
            session,
            int(user.id),
            "What is a trie?",
            "A trie stores strings by prefix.",
            "cheap-test-model",
        )
        assert result["user_candidate_id"] is not None
        user_row = session.get(GlobalQACache, int(result["user_candidate_id"]))
        assert user_row is not None
        user_row.embedding_json = "{broken"
        user_row.token_hash_embedding_json = "{broken"
        session.add(user_row)
        session.commit()

        hit = lookup_approved_global_cache(session, "What is a trie?", "en", user_id=int(user.id))

    assert hit is not None
    assert hit["scope"] == "user"
    assert hit["cache_hit_source"] == "L2_user_global_qa"


def test_tombstone_invalidation_does_not_revoke_unrelated_user_rows():
    reset_global_qa_hot_cache_for_tests()
    first = create_test_user("strict-tombstone-1", "strict-tombstone-1@example.com")
    second = create_test_user("strict-tombstone-2", "strict-tombstone-2@example.com")
    first_row_id = _insert_global_entry(
        "What is alpha cache?",
        "Alpha user answer.",
        topic="alpha",
        scope="user",
        user_id=int(first.id),
    )
    second_row_id = _insert_global_entry(
        "What is beta cache?",
        "Beta user answer.",
        topic="beta",
        scope="user",
        user_id=int(second.id),
    )

    with SessionLocal() as session:
        record_global_qa_tombstone(session, first_row_id, reason="test_delete")
        payload = build_global_knowledge_sync_payload(session, user_id=int(second.id))
        hit = lookup_approved_global_cache(session, "What is beta cache?", "en", user_id=int(second.id))

    assert hit is not None
    assert hit["id"] == second_row_id
    assert payload["userEntries"]
    assert payload["userEntries"][0]["id"] == f"user-global:{second_row_id}"


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


def test_topic_seed_sync_returns_relevant_global_and_owned_user_entries(client):
    owner = create_test_user("topic-owner", "topic-owner@example.com")
    other = create_test_user("topic-other", "topic-other@example.com")
    _insert_global_entry(
        "What is section 80c deduction?",
        "Section 80C is an Indian income-tax deduction category.",
        topic="tax",
    )
    _insert_global_entry(
        "What is owner-only section 80c note?",
        "Owner section 80C note.",
        topic="tax",
        scope="user",
        user_id=int(owner.id),
    )
    _insert_global_entry(
        "What is other-only section 80c note?",
        "Other section 80C note.",
        topic="tax",
        scope="user",
        user_id=int(other.id),
    )

    response = client.get(
        "/api/global-knowledge/sync?limit=1&since=2099-01-01T00:00:00Z&topicSeeds=section%2080c&topic_seeds=section%2080c",
        headers=auth_headers("topic-owner", "topic-owner@example.com"),
    )

    assert response.status_code == 200
    payload = response.json()
    serialized_entries = json.dumps(payload["entries"])
    serialized_user_entries = json.dumps(payload["userEntries"])
    assert "Section 80C is an Indian income-tax deduction category." in serialized_entries
    assert "Owner section 80C note." in serialized_user_entries
    assert "Other section 80C note." not in serialized_user_entries
