from __future__ import annotations

import json

from sqlmodel import select

from app.ai.types import AIProviderResponse
from app.database import SessionLocal
from app.models import (
    GlobalQACache, UsageCharge, WebChatMessage, WebChatThread, WebConversationSummary,
    WebMemoryFact, WebUsagePreferences,
)
from app.web_api.chat_service import EditRequestError, execute_web_turn, prepare_web_turn
from app.web_api.web_memory import retrieve_memory, write_turn_memory
from tests.conftest import auth_headers, create_test_user
from tests.test_web_chat_api import _fund, _sse_events


class Provider:
    def stream_complete(self, request, route, on_delta):
        text = "A complete roadmap with milestones and projects."
        on_delta(text)
        return AIProviderResponse(
            text=text, provider="openai", model=route.model, route=route.route,
            reason=route.reason, language="en", intent=route.intent,
            input_tokens=20, output_tokens=10,
            raw={
                "usage_actual": True, "provider_attempts": 1,
                "provider_calls_with_usage": 1, "finish_reason": "stop",
                "truncated": False, "completion_status": "complete",
            },
        )


def test_standalone_turn_has_no_history_memory_or_document_and_one_provider_call(monkeypatch):
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    monkeypatch.setenv("WEB_PROMPT_TOKEN_BREAKDOWN_ENABLED", "true")
    user = create_test_user("standalone-user", "standalone-user@example.com")
    _fund(int(user.id))
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), memory_enabled=True))
        old_thread = WebChatThread(user_id=int(user.id), title="Old roadmap")
        session.add(old_thread); session.flush()
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="project:old",
            value_text="Uses a private roadmap", category="ongoing_project",
            source_thread_id=old_thread.id,
        ))
        session.commit()

    prepared = prepare_web_turn(
        user_id=int(user.id), message="What is photosynthesis?",
        request_id="standalone-request-1", thread_id=None, reply_language="en",
    )
    assert prepared.ai_request.context_turns == []
    assert prepared.ai_request.metadata.get("memory_prompt_context") == ""
    assert prepared.ai_request.metadata.get("attachment_prompt_context") == ""
    assert [item["role"] for item in prepared.provider_messages] == ["system", "user"]

    calls = 0

    class CountingProvider(Provider):
        def stream_complete(self, request, route, on_delta):
            nonlocal calls
            calls += 1
            return super().stream_complete(request, route, on_delta)

    completed = execute_web_turn(
        prepared, on_delta=lambda _value: None,
        providers={"openai": CountingProvider()},
    )
    assert calls == 1
    assert not isinstance(completed.message, WebChatMessage)
    with SessionLocal() as session:
        persisted = session.get(WebChatMessage, completed.message.id)
        assert persisted is not None
        stored = json.loads(persisted.metadata_json)
    for key in (
        "system_prompt_estimated_tokens", "user_message_estimated_tokens",
        "same_thread_estimated_tokens", "memory_estimated_tokens",
        "profile_estimated_tokens", "attachment_estimated_tokens",
        "total_estimated_prompt_tokens", "max_output_tokens", "answer_class",
        "provider_attempts", "reserved_micros", "charged_micros",
        "usage_source", "finish_reason", "truncated",
        "same_thread_context_mode", "same_thread_context_reason",
        "same_thread_context_confidence", "same_thread_context_turns_sent",
        "same_thread_context_chars_sent",
    ):
        assert key in stored
    assert stored["same_thread_estimated_tokens"] == 0
    assert stored["memory_estimated_tokens"] == 0
    assert stored["attachment_estimated_tokens"] == 0


def test_fresh_thread_natural_followup_retrieves_memory_only_when_enabled(monkeypatch):
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    monkeypatch.setenv("WEB_SAME_THREAD_CONTEXT_MODE", "adaptive")
    user = create_test_user("natural-memory-user", "natural-memory-user@example.com")
    _fund(int(user.id))
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), memory_enabled=True))
        old_thread = WebChatThread(user_id=int(user.id), title="Developer plan")
        session.add(old_thread)
        session.flush()
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="project:developer-plan",
            value_text="The software developer plan starts with Python and FastAPI.",
            category="ongoing_project", source_thread_id=old_thread.id,
        ))
        session.commit()

    enabled = prepare_web_turn(
        user_id=int(user.id), message="how do I implement that plan we made?",
        request_id="natural-memory-enabled", thread_id=None, reply_language="en",
    )
    assert enabled.continuity_decision is not None
    assert enabled.continuity_decision.use_context is True
    assert enabled.continuity_decision.reason == "referential_language"
    assert "software developer plan" in enabled.ai_request.metadata["memory_prompt_context"]

    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "false")
    disabled = prepare_web_turn(
        user_id=int(user.id), message="how do I implement that plan we made?",
        request_id="natural-memory-disabled", thread_id=None, reply_language="en",
    )
    assert disabled.ai_request.metadata["memory_prompt_context"] == ""


def test_edit_latest_message_creates_revision_and_preserves_settled_charge(monkeypatch):
    monkeypatch.setenv("WEB_MESSAGE_EDIT_ENABLED", "true")
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    user = create_test_user("edit-user", "edit-user@example.com")
    _fund(int(user.id))
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), memory_enabled=True))
        session.commit()
    first = prepare_web_turn(
        user_id=int(user.id), message="Give me a roadmap", request_id="edit-request-1",
        thread_id=None, reply_language="en",
    )
    first_done = execute_web_turn(first, on_delta=lambda _value: None, providers={"openai": Provider()})
    with SessionLocal() as session:
        original_user = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == "edit-request-1", WebChatMessage.role == "user"
        )).one()
        original_charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == "edit-request-1"
        )).one()
        original_debit = original_charge.debited_micros
        original_user_id = original_user.id
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="project:original-edit",
            value_text="Original roadmap", category="ongoing_project",
            source_thread_id=first_done.thread_id, source_message_id=original_user_id,
        ))
        session.commit()

    edited = prepare_web_turn(
        user_id=int(user.id), message="Give me a complete backend roadmap",
        request_id="edit-request-2", thread_id=first_done.thread_id,
        reply_language="en", edit_message_id=original_user_id,
    )
    execute_web_turn(edited, on_delta=lambda _value: None, providers={"openai": Provider()})
    with SessionLocal() as session:
        original = session.get(WebChatMessage, original_user_id)
        replacement = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == "edit-request-2", WebChatMessage.role == "user"
        )).one()
        original_charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == "edit-request-1"
        )).one()
        assert original is not None and original.superseded_at is not None
        assert replacement.replaces_message_id == original_user_id
        assert replacement.revision_number == 2
        assert original_charge.status == "settled"
        assert original_charge.debited_micros == original_debit
        assert session.exec(select(UsageCharge)).all().__len__() == 2
        old_fact = session.exec(select(WebMemoryFact).where(
            WebMemoryFact.normalized_key == "project:original-edit"
        )).one()
        assert old_fact.deleted_at is not None
        summary = session.exec(select(WebConversationSummary).where(
            WebConversationSummary.thread_id == first_done.thread_id
        )).one()
        assert "complete backend roadmap" in summary.summary_text.lower()


def test_hidden_continuation_control_does_not_hide_latest_visible_edit(
    monkeypatch,
):
    monkeypatch.setenv("WEB_MESSAGE_EDIT_ENABLED", "true")
    user = create_test_user(
        "edit-after-control", "edit-after-control@example.com"
    )
    _fund(int(user.id))
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Continuation")
        session.add(thread)
        session.flush()
        visible = WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="user",
            content="Build a small API",
            request_id="visible-edit-target",
            status="complete",
        )
        session.add(visible)
        session.flush()
        session.add(WebChatMessage(
            thread_id=thread.id,
            user_id=int(user.id),
            role="user",
            content="Continue response",
            request_id="hidden-control",
            status="complete",
            metadata_json=json.dumps({
                "is_continuation_control": True,
            }),
        ))
        session.commit()
        thread_id = thread.id
        visible_id = visible.id

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Build a small FastAPI service",
        request_id="visible-edit-revision",
        thread_id=thread_id,
        reply_language="en",
        edit_message_id=visible_id,
    )

    assert prepared.request_id == "visible-edit-revision"
    with SessionLocal() as session:
        original = session.get(WebChatMessage, visible_id)
        replacement = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == "visible-edit-revision",
            WebChatMessage.role == "user",
        )).one()
        assert original is not None and original.superseded_at is not None
        assert replacement.replaces_message_id == visible_id


def test_edit_rejects_cross_user_target(monkeypatch):
    monkeypatch.setenv("WEB_MESSAGE_EDIT_ENABLED", "true")
    owner = create_test_user("edit-owner", "edit-owner@example.com")
    stranger = create_test_user("edit-stranger", "edit-stranger@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(owner.id), title="Owner")
        session.add(thread); session.flush()
        message = WebChatMessage(
            thread_id=thread.id, user_id=int(owner.id), role="user", content="Private",
            request_id="private-edit", status="complete",
        )
        session.add(message); session.commit(); message_id = message.id; thread_id = thread.id
    try:
        prepare_web_turn(
            user_id=int(stranger.id), message="Steal", request_id="cross-edit",
            thread_id=thread_id, reply_language="en", edit_message_id=message_id,
        )
    except (EditRequestError, LookupError):
        pass
    else:
        raise AssertionError("cross-user edit must fail")


def test_memory_retrieval_is_bounded_isolated_deleted_and_disabled(monkeypatch):
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    monkeypatch.setenv("WEB_MEMORY_MAX_ITEMS", "2")
    monkeypatch.setenv("WEB_MEMORY_MAX_CHARS", "1200")
    user = create_test_user("memory-user", "memory-user@example.com")
    other = create_test_user("memory-other", "memory-other@example.com")
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), memory_enabled=True))
        session.add(WebUsagePreferences(user_id=int(other.id), memory_enabled=True))
        thread = WebChatThread(user_id=int(user.id), title="Developer roadmap")
        other_thread = WebChatThread(user_id=int(other.id), title="Secret roadmap")
        session.add(thread); session.add(other_thread); session.flush()
        session.add(WebConversationSummary(
            user_id=int(user.id), thread_id=thread.id,
            summary_text="A software developer roadmap using Python and PostgreSQL.",
            keywords_text="software developer roadmap python postgresql",
        ))
        session.add(WebConversationSummary(
            user_id=int(other.id), thread_id=other_thread.id,
            summary_text="Other user's secret architecture.", keywords_text="secret architecture",
        ))
        deleted = WebMemoryFact(
            user_id=int(user.id), normalized_key="preference:deleted",
            value_text="deleted preference", category="preference",
            deleted_at=thread.created_at,
        )
        session.add(deleted); session.commit()
        result = retrieve_memory(
            session, user_id=int(user.id),
            message="Continue the roadmap we discussed", current_thread_id=None,
        )
        assert "software developer roadmap" in result.prompt_context
        assert "secret architecture" not in result.prompt_context
        assert "deleted preference" not in result.prompt_context
        assert len(result.records) <= 2 and len(result.prompt_context) <= 1200
        generic_memory = retrieve_memory(
            session, user_id=int(user.id), message="What did I decide yesterday?",
            current_thread_id=None,
        )
        assert "software developer roadmap" in generic_memory.prompt_context
        standalone = retrieve_memory(
            session, user_id=int(user.id), message="What is photosynthesis?",
            current_thread_id=None,
        )
        assert standalone.prompt_context == ""
        preferences = session.exec(select(WebUsagePreferences).where(
            WebUsagePreferences.user_id == int(user.id)
        )).one()
        preferences.memory_enabled = False; session.add(preferences); session.commit()
        disabled = retrieve_memory(
            session, user_id=int(user.id),
            message="Continue the roadmap we discussed", current_thread_id=None,
        )
        assert disabled.prompt_context == ""


def test_ranked_memory_honors_top_one_top_two_threshold_and_superseded(
    monkeypatch,
):
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    monkeypatch.setenv("WEB_MEMORY_FACT_RANKING_ENABLED", "true")
    monkeypatch.setenv("WEB_MEMORY_FACT_MIN_SIMILARITY", "0.6")
    monkeypatch.setattr(
        "app.web_api.web_memory.cached_text_embedding",
        lambda *_args, **_kwargs: [1.0, 0.0],
    )
    user = create_test_user("ranked-memory", "ranked-memory@example.com")
    other = create_test_user("ranked-memory-other", "ranked-memory-other@example.com")
    with SessionLocal() as session:
        session.add(WebUsagePreferences(
            user_id=int(user.id), memory_enabled=True
        ))
        session.add(WebUsagePreferences(
            user_id=int(other.id), memory_enabled=True
        ))
        thread = WebChatThread(user_id=int(user.id), title="Sources")
        session.add(thread); session.flush()
        superseded = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="Old fact", request_id="ranked-old", status="complete",
            superseded_at=thread.created_at,
        )
        session.add(superseded); session.flush()
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="ranked:first",
            value_text="First relevant fact", category="preference",
            embedding_json="[1,0]", embedding_norm=1.0,
        ))
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="ranked:second",
            value_text="Second relevant fact", category="decision",
            embedding_json="[0.8,0.2]",
            embedding_norm=(0.8 ** 2 + 0.2 ** 2) ** 0.5,
        ))
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="ranked:below",
            value_text="Below threshold", category="decision",
            embedding_json="[0,1]", embedding_norm=1.0,
        ))
        session.add(WebMemoryFact(
            user_id=int(user.id), normalized_key="ranked:superseded",
            value_text="Superseded source", category="decision",
            embedding_json="[1,0]", embedding_norm=1.0,
            source_message_id=superseded.id,
        ))
        session.add(WebMemoryFact(
            user_id=int(other.id), normalized_key="ranked:other",
            value_text="Other user secret", category="decision",
            embedding_json="[1,0]", embedding_norm=1.0,
        ))
        session.commit()

        monkeypatch.setenv("WEB_MEMORY_MAX_ITEMS", "1")
        top_one = retrieve_memory(
            session, user_id=int(user.id), message="Relevant",
            current_thread_id=None,
        )
        monkeypatch.setenv("WEB_MEMORY_MAX_ITEMS", "2")
        top_two = retrieve_memory(
            session, user_id=int(user.id), message="Relevant",
            current_thread_id=None,
        )
    assert len(top_one.records) == 1
    assert len(top_two.records) == 2
    assert "Below threshold" not in top_two.prompt_context
    assert "Superseded source" not in top_two.prompt_context
    assert "Other user secret" not in top_two.prompt_context


def test_disabled_memory_writer_creates_no_records(monkeypatch):
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    user = create_test_user("memory-disabled", "memory-disabled@example.com")
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), memory_enabled=False))
        thread = WebChatThread(user_id=int(user.id), title="Private project")
        session.add(thread); session.flush()
        user_message = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="Remember that my project uses PostgreSQL", request_id="memory-disabled-1",
        )
        assistant_message = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="Understood.", request_id="memory-disabled-1",
        )
        session.add(user_message); session.add(assistant_message); session.flush()
        write_turn_memory(
            session, user_id=int(user.id), thread_id=thread.id,
            user_message=user_message, assistant_message=assistant_message,
            answer_class="normal",
        )
        session.commit()
        assert session.exec(select(WebMemoryFact)).all() == []
        assert session.exec(select(WebConversationSummary)).all() == []


def test_completed_answer_regeneration_is_revisioned_billed_and_idempotent(
    monkeypatch,
):
    monkeypatch.setenv("WEB_MESSAGE_EDIT_ENABLED", "true")
    monkeypatch.setenv("GLOBAL_QA_CONFIDENCE_FLOOR", "0.35")
    user = create_test_user("regen-user", "regen-user@example.com")
    _fund(int(user.id))
    first = prepare_web_turn(
        user_id=int(user.id), message="Give me a roadmap",
        request_id="regen-request-1", thread_id=None, reply_language="en",
    )
    first_done = execute_web_turn(
        first, on_delta=lambda _value: None, providers={"openai": Provider()}
    )
    with SessionLocal() as session:
        cache = GlobalQACache(
            canonical_question="Give me a roadmap",
            normalized_question="give me a roadmap",
            answer="Old cached roadmap", answer_language="en",
            scope="global", status="approved", hit_count=2,
            distinct_user_count=2, observed_question_count=2,
            source_question_hashes_json="[]", answer_hash="regen-cache",
            confidence=0.5, safety_label="general",
        )
        session.add(cache); session.flush()
        original = session.get(WebChatMessage, first_done.message.id)
        metadata = json.loads(original.metadata_json)
        metadata["cache_row_id"] = cache.id
        original.metadata_json = json.dumps(metadata)
        session.add(original); session.commit()
        original_id = original.id

    regenerated = prepare_web_turn(
        user_id=int(user.id), message="Give me a roadmap",
        request_id="regen-request-2", thread_id=first_done.thread_id,
        reply_language="en", regenerate_message_id=original_id,
    )
    regenerated_done = execute_web_turn(
        regenerated, on_delta=lambda _value: None,
        providers={"openai": Provider()},
    )
    replay = prepare_web_turn(
        user_id=int(user.id), message="Give me a roadmap",
        request_id="regen-request-2", thread_id=first_done.thread_id,
        reply_language="en", regenerate_message_id=original_id,
    )
    assert replay.existing_response_id is not None
    with SessionLocal() as session:
        old = session.get(WebChatMessage, original_id)
        new = session.get(WebChatMessage, regenerated_done.message.id)
        cache = session.exec(select(GlobalQACache).where(
            GlobalQACache.answer_hash == "regen-cache"
        )).one()
        charges = session.exec(select(UsageCharge).where(
            UsageCharge.user_id == int(user.id)
        )).all()
    assert old is not None and old.superseded_at is not None
    assert new is not None and new.replaces_message_id == original_id
    assert new.revision_number == 2
    assert json.loads(new.metadata_json)["regenerated_cache_row_id"] == cache.id
    assert cache.confidence == 0.35 and cache.status == "rejected"
    assert len(charges) == 2


def test_regeneration_sse_finishes_after_cache_confidence_correction(
    client, monkeypatch,
):
    monkeypatch.setenv("WEB_MESSAGE_EDIT_ENABLED", "true")
    monkeypatch.setenv("GLOBAL_QA_CONFIDENCE_FLOOR", "0.35")
    user = create_test_user("regen-sse", "regen-sse@example.com")
    _fund(int(user.id))

    def stream(self, request, route, on_delta):
        return Provider().stream_complete(request, route, on_delta)

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete", stream
    )
    headers = auth_headers("regen-sse", "regen-sse@example.com")
    first = client.post(
        "/api/web/chat/stream",
        headers=headers,
        json={
            "request_id": "77000000-0000-4000-8000-000000000001",
            "message": "Give me a roadmap",
        },
    )
    first_done = _sse_events(first, "done")[0]
    original_id = first_done["message_id"]
    thread_id = first_done["thread_id"]
    with SessionLocal() as session:
        cache = GlobalQACache(
            canonical_question="Give me a roadmap",
            normalized_question="give me a roadmap",
            answer="Old cached roadmap",
            answer_language="en",
            scope="global",
            status="approved",
            hit_count=2,
            distinct_user_count=2,
            observed_question_count=2,
            source_question_hashes_json="[]",
            answer_hash="regen-sse-cache",
            confidence=0.5,
            safety_label="general",
        )
        session.add(cache)
        session.flush()
        original = session.get(WebChatMessage, original_id)
        assert original is not None
        metadata = json.loads(original.metadata_json)
        metadata["cache_row_id"] = cache.id
        original.metadata_json = json.dumps(metadata)
        session.add(original)
        session.commit()
        cache_id = cache.id
    regenerated = client.post(
        "/api/web/chat/stream",
        headers=headers,
        json={
            "request_id": "77000000-0000-4000-8000-000000000002",
            "message": "Give me a roadmap",
            "thread_id": thread_id,
            "regenerate_message_id": original_id,
        },
    )
    assert regenerated.status_code == 200
    assert _sse_events(regenerated, "usage")
    assert _sse_events(regenerated, "wallet")
    done = _sse_events(regenerated, "done")
    assert done and not done[0]["cancelled"]
    assert not _sse_events(regenerated, "error")
    with SessionLocal() as session:
        old = session.get(WebChatMessage, original_id)
        new = session.get(WebChatMessage, done[0]["message_id"])
        corrected = session.get(GlobalQACache, cache_id)
        charges = session.exec(
            select(UsageCharge).where(UsageCharge.user_id == int(user.id))
        ).all()
    assert old is not None and old.superseded_at is not None
    assert new is not None and new.replaces_message_id == original_id
    assert new.revision_number == 2
    assert corrected is not None
    assert corrected.confidence == 0.35 and corrected.status == "rejected"
    assert len(charges) == 2


def test_memory_settings_are_owner_scoped_and_support_delete_and_clear(client, monkeypatch):
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    owner = create_test_user("memory-settings-owner", "memory-settings-owner@example.com")
    create_test_user("memory-settings-other", "memory-settings-other@example.com")
    owner_headers = auth_headers("memory-settings-owner", "memory-settings-owner@example.com")
    other_headers = auth_headers("memory-settings-other", "memory-settings-other@example.com")
    enabled = client.patch(
        "/api/web/settings/memory", headers=owner_headers, json={"enabled": True}
    )
    assert enabled.status_code == 200 and enabled.json()["enabled"] is True
    with SessionLocal() as session:
        first = WebMemoryFact(
            user_id=int(owner.id), normalized_key="preference:first",
            value_text="Concise replies", category="reply_style",
        )
        second = WebMemoryFact(
            user_id=int(owner.id), normalized_key="project:second",
            value_text="Backend migration", category="ongoing_project",
        )
        session.add(first); session.add(second); session.commit()
        first_id = first.id
    listing = client.get("/api/web/settings/memory", headers=owner_headers)
    assert listing.status_code == 200
    assert {item["value_text"] for item in listing.json()["items"]} == {
        "Concise replies", "Backend migration",
    }
    assert client.delete(
        f"/api/web/settings/memory/{first_id}", headers=other_headers
    ).status_code == 404
    assert client.delete(
        f"/api/web/settings/memory/{first_id}", headers=owner_headers
    ).status_code == 204
    assert client.delete("/api/web/settings/memory", headers=owner_headers).status_code == 204
    assert client.get("/api/web/settings/memory", headers=owner_headers).json()["items"] == []


def test_explicit_memory_write_and_cross_chat_retrieval_are_owner_scoped(
    client, monkeypatch,
):
    monkeypatch.setenv("WEB_CROSS_THREAD_MEMORY_ENABLED", "true")
    monkeypatch.setenv("WEB_MEMORY_FACT_RANKING_ENABLED", "false")
    monkeypatch.setenv("WEB_RESPONSE_PROVENANCE_ENABLED", "true")
    owner = create_test_user("explicit-memory-owner", "explicit-memory-owner@example.com")
    other = create_test_user("explicit-memory-other", "explicit-memory-other@example.com")
    _fund(int(owner.id))
    _fund(int(other.id))
    owner_headers = auth_headers(
        "explicit-memory-owner", "explicit-memory-owner@example.com"
    )
    other_headers = auth_headers(
        "explicit-memory-other", "explicit-memory-other@example.com"
    )
    assert client.patch(
        "/api/web/settings/memory",
        headers=owner_headers,
        json={"enabled": True},
    ).json()["enabled"] is True
    assert client.patch(
        "/api/web/settings/memory",
        headers=other_headers,
        json={"enabled": True},
    ).json()["enabled"] is True

    monkeypatch.setattr(
        "app.web_api.web_memory.cached_text_embedding",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("explicit memory writes must not embed synchronously")
        ),
    )
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("explicit memory writes must not call a chat model")
        ),
    )
    write_response = client.post(
        "/api/web/chat/stream",
        headers=owner_headers,
        json={
            "request_id": "75000000-0000-4000-8000-000000000001",
            "message": (
                "Remember that my preferred reply style is concise "
                "Tamil-English."
            ),
        },
    )
    assert write_response.status_code == 200
    assert "Saved to cross-chat memory." in write_response.text
    assert '"backend_tool"' in write_response.text
    assert _sse_events(write_response, "done")[0]["memory_updated"] is True
    listing = client.get("/api/web/settings/memory", headers=owner_headers).json()
    assert [item["value_text"] for item in listing["items"]] == [
        "concise Tamil-English."
    ]

    observed_contexts: dict[int, str] = {}

    def answer_from_memory(self, request, route, on_delta):
        context = str(request.metadata.get("memory_prompt_context") or "")
        observed_contexts[int(request.user_id)] = context
        text = (
            "You prefer concise Tamil-English replies."
            if context else "I do not have a saved reply preference for you."
        )
        on_delta(text)
        return AIProviderResponse(
            text=text,
            provider="openai",
            model=route.model,
            route=route.route,
            reason=route.reason,
            language="en",
            intent=route.intent,
            input_tokens=20,
            output_tokens=8,
            raw={"usage_actual": True, "completion_status": "complete"},
        )

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        answer_from_memory,
    )
    owner_answer = client.post(
        "/api/web/chat/stream",
        headers=owner_headers,
        json={
            "request_id": "75000000-0000-4000-8000-000000000002",
            "message": "What reply style do I prefer?",
        },
    )
    other_answer = client.post(
        "/api/web/chat/stream",
        headers=other_headers,
        json={
            "request_id": "75000000-0000-4000-8000-000000000003",
            "message": "What reply style do I prefer?",
        },
    )
    assert owner_answer.status_code == other_answer.status_code == 200
    assert "You prefer concise Tamil-English replies." in owner_answer.text
    assert '"memory"' in owner_answer.text
    assert "I do not have a saved reply preference for you." in other_answer.text
    assert "concise Tamil-English" in observed_contexts[int(owner.id)]
    assert observed_contexts[int(other.id)] == ""
    with SessionLocal() as session:
        assert session.exec(
            select(GlobalQACache).where(
                GlobalQACache.normalized_question
                == "what reply style do i prefer"
            )
        ).all() == []
