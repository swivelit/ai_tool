from __future__ import annotations

import json

from sqlmodel import select

from app.ai.types import AIProviderResponse
from app.database import SessionLocal
from app.models import (
    UsageCharge, WebChatMessage, WebChatThread, WebConversationSummary,
    WebMemoryFact, WebUsagePreferences,
)
from app.web_api.chat_service import EditRequestError, execute_web_turn, prepare_web_turn
from app.web_api.web_memory import retrieve_memory, write_turn_memory
from tests.conftest import auth_headers, create_test_user
from tests.test_web_chat_api import _fund


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
    stored = json.loads(completed.message.metadata_json)
    for key in (
        "system_prompt_estimated_tokens", "user_message_estimated_tokens",
        "same_thread_estimated_tokens", "memory_estimated_tokens",
        "profile_estimated_tokens", "attachment_estimated_tokens",
        "total_estimated_prompt_tokens", "max_output_tokens", "answer_class",
        "provider_attempts", "reserved_micros", "charged_micros",
        "usage_source", "finish_reason", "truncated",
    ):
        assert key in stored
    assert stored["same_thread_estimated_tokens"] == 0
    assert stored["memory_estimated_tokens"] == 0
    assert stored["attachment_estimated_tokens"] == 0


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
    monkeypatch.setenv("WEB_MEMORY_MAX_ITEMS", "4")
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
        assert len(result.records) <= 4 and len(result.prompt_context) <= 1200
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
