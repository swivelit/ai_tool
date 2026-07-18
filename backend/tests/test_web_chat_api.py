from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from app.ai.types import AIProviderResponse, AIRequest
from app.ai.providers.base import GenerationCancelled
from app.billing.pricing import calculate_topup, price_usage
from app.billing.service import credit_payment_once, get_wallet_summary
from app.database import SessionLocal
from app.models import (
    PaymentOrder, UsageCharge, WalletLedger, WebChatMessage, WebChatThread,
    WebUsagePreferences,
    UserProfile,
)
from sqlmodel import select
from app.ai import orchestrator
from tests.conftest import auth_headers, create_test_user
from app.web_api.upload_store import EphemeralUpload, ExtractedChunk, get_upload_store, utc_iso


def test_thread_ownership_for_read_rename_delete(client):
    owner = create_test_user("owner", "owner@example.com")
    other = create_test_user("other", "other@example.com")
    with SessionLocal() as session:
        row = WebChatThread(user_id=int(owner.id), title="Private"); session.add(row); session.commit(); thread_id = row.id
    headers = auth_headers("other", "other@example.com")
    assert client.get(f"/api/web/threads/{thread_id}", headers=headers).status_code == 404
    assert client.patch(f"/api/web/threads/{thread_id}", headers=headers, json={"title":"Stolen"}).status_code == 404
    assert client.delete(f"/api/web/threads/{thread_id}", headers=headers).status_code == 404
    assert client.get(f"/api/web/threads/{thread_id}/messages", headers=headers).status_code == 404


def test_insufficient_credit_returns_402_before_provider(client, monkeypatch):
    create_test_user()
    called = {"value": False}
    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.complete", lambda *args: called.update(value=True))
    response = client.post("/api/web/chat/stream", headers=auth_headers("test-uid"), json={"request_id":"57a958f1-42c8-4c68-9ab0-bf03539e9aac","message":"Explain database indexes"})
    assert response.status_code == 402
    assert response.json()["error"]["code"] == "insufficient_credit"
    assert called["value"] is False


def test_web_billing_metadata_skips_mobile_quota_only(monkeypatch):
    calls = []
    monkeypatch.setattr(orchestrator, "enforce_free_text_quota", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr("app.ai.agents.negative_cache_agent.default_negative_cache_agent.get", lambda message: type("Hit", (), {"text":"blocked", "route":"negative", "reason":"test"})())
    with SessionLocal() as session:
        web = AIRequest(1, "x", "en", "text", "web", {"client_surface":"web", "billing_required":True, "skip_free_text_quota":True})
        orchestrator.run_text_turn(session, web)
        mobile = AIRequest(1, "x", "en", "text", "mobile", {})
        orchestrator.run_text_turn(session, mobile)
    assert len(calls) == 1


def test_browser_user_id_is_not_accepted(client):
    create_test_user()
    response = client.post("/api/web/threads", headers=auth_headers("test-uid"), json={"title":"Mine", "user_id":99999})
    assert response.status_code == 201
    assert "user_id" not in response.json()


def test_web_chat_rejects_client_routing_fields(client):
    create_test_user()
    for field in ("model", "provider", "tier"):
        response = client.post(
            "/api/web/chat/stream",
            headers=auth_headers("test-uid"),
            json={
                "request_id": "4df3a124-4db7-4765-8110-35d969756589",
                "message": "Hello",
                field: "arbitrary",
            },
        )
        assert response.status_code == 422


def test_historical_message_without_public_tier_serializes_as_swico(client):
    user = create_test_user("history-tier", "history-tier@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="History")
        session.add(thread); session.flush()
        session.add(WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="Historical response", provider="openai", model="gpt-5-nano",
            swico_tier=None, input_tokens=4, output_tokens=2, usage_source="actual",
        ))
        session.commit(); thread_id = thread.id
    response = client.get(
        f"/api/web/threads/{thread_id}/messages",
        headers=auth_headers("history-tier", "history-tier@example.com"),
    )
    message = response.json()["items"][0]
    assert message["tier"] is None and message["tier_label"] == "Swico"
    assert "provider" not in message and "model" not in message


def _fund(user_id: int):
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        order = PaymentOrder(user_id=user_id, receipt=f"fund-{user_id}", provider_order_id=f"fund-order-{user_id}", gross_amount_paise=1000, credited_amount_micros=credit, platform_share_paise=platform, status="captured")
        session.add(order); session.flush(); credit_payment_once(session, order); session.commit()


def _stream_text(response) -> str:
    return "\n".join(
        json.loads(line.removeprefix("data: ")).get("text", "")
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"text"' in line
    )


def _sse_events(response, event_name: str) -> list[dict]:
    lines = response.text.splitlines()
    return [
        json.loads(lines[index + 1].removeprefix("data: "))
        for index, line in enumerate(lines[:-1])
        if line == f"event: {event_name}" and lines[index + 1].startswith("data: ")
    ]


def test_saved_profile_language_is_authoritative_and_voice_metadata_is_serialized(client, monkeypatch):
    english = create_test_user("language-en", "language-en@example.com")
    tamil = create_test_user("language-ta", "language-ta@example.com")
    with SessionLocal() as session:
        tamil_row = session.get(type(tamil), int(tamil.id)); tamil_row.reply_language = "ta"
        session.add(tamil_row); session.commit()
    _fund(int(english.id)); _fund(int(tamil.id))

    def localized(self, request, route, on_delta):
        text = "தமிழ் பதில்" if request.reply_language == "ta" else "English answer"
        on_delta(text)
        provider = "sarvam" if self.__class__.__name__ == "SarvamProvider" else "openai"
        return AIProviderResponse(
            text=text, provider=provider, model=route.model, route=route.route,
            reason=route.reason, language=request.reply_language or "en", intent=route.intent,
            input_tokens=20, output_tokens=10, raw={"usage_actual": True},
        )
    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", localized)
    monkeypatch.setattr("app.ai.providers.sarvam_provider.SarvamProvider.stream_complete", localized)

    english_voice_turn = "11111111-1111-4111-8111-111111111111"
    english_response = client.post(
        "/api/web/chat/stream", headers=auth_headers("language-en", "language-en@example.com"),
        json={
            "request_id": "11111111-1111-4111-8111-111111111112",
            "message": "இதை விளக்குங்கள்", "reply_language": "ta", "input_mode": "voice",
            "voice_turn_id": english_voice_turn,
        },
    )
    tamil_response = client.post(
        "/api/web/chat/stream", headers=auth_headers("language-ta", "language-ta@example.com"),
        json={
            "request_id": "22222222-2222-4222-8222-222222222222",
            "message": "Explain this", "reply_language": "en", "input_mode": "text",
        },
    )
    assert english_response.status_code == tamil_response.status_code == 200
    assert "English answer" in _stream_text(english_response)
    assert "தமிழ் பதில்" in _stream_text(tamil_response)
    done = _sse_events(english_response, "done")[0]
    assert done["input_mode"] == "voice"
    assert done["voice_turn_id"] == english_voice_turn
    assert done["reply_language"] == "en" and done["message_id"]
    with SessionLocal() as session:
        rows = session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == int(english.id)
        )).all()
        assert {row.role for row in rows} == {"user", "assistant"}
        for row in rows:
            metadata = json.loads(row.metadata_json)
            assert metadata["input_mode"] == "voice"
            assert metadata["voice_turn_id"] == english_voice_turn
            assert metadata["reply_language"] == "en"
        thread_id = rows[0].thread_id
    serialized = client.get(
        f"/api/web/threads/{thread_id}/messages",
        headers=auth_headers("language-en", "language-en@example.com"),
    ).json()["items"]
    assert all(item["input_mode"] == "voice" for item in serialized)
    assert all(item["voice_turn_id"] == english_voice_turn for item in serialized)
    assert all(item["reply_language"] == "en" for item in serialized)


def test_web_chat_voice_input_requires_turn_id_and_text_rejects_it(client):
    create_test_user("voice-schema", "voice-schema@example.com")
    headers = auth_headers("voice-schema", "voice-schema@example.com")
    base = {"request_id": "33333333-3333-4333-8333-333333333333", "message": "hello"}
    assert client.post(
        "/api/web/chat/stream", headers=headers, json={**base, "input_mode": "voice"}
    ).status_code == 422
    assert client.post(
        "/api/web/chat/stream", headers=headers,
        json={**base, "input_mode": "text", "voice_turn_id": str(__import__('uuid').uuid4())},
    ).status_code == 422


def test_deterministic_web_intents_are_saved_zero_charge_and_replay_safely(client):
    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    cases = [
        ("hello", "Hi! How can I help you today?"),
        ("thanks", "You’re welcome."),
        ("what can you do?", "I can help with questions, explanations, writing, planning, and coding."),
    ]
    for index, (message, expected) in enumerate(cases, start=1):
        request_id = f"00000000-0000-4000-8000-{index:012d}"
        body = {"request_id": request_id, "message": message}
        first = client.post("/api/web/chat/stream", headers=headers, json=body)
        second = client.post("/api/web/chat/stream", headers=headers, json=body)
        assert first.status_code == second.status_code == 200
        assert expected in _stream_text(first)
        assert expected in _stream_text(second)
        assert "Swico cannot complete this request through the current web route." not in first.text
        with SessionLocal() as session:
            assistant = session.exec(select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "assistant",
            )).one()
            assert assistant.content == expected
            assert assistant.charge_micros == 0
            assert assistant.input_tokens == assistant.output_tokens == 0
            assert assistant.usage_source is None
            assert session.exec(select(UsageCharge).where(
                UsageCharge.request_id == request_id
            )).first() is None
    with SessionLocal() as session:
        assert session.exec(select(WalletLedger).where(
            WalletLedger.user_id == int(user.id)
        )).all() == []


def test_unsupported_web_tool_is_truthful_and_safety_stays_distinct(client):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    unsupported = client.post("/api/web/chat/stream", headers=headers, json={
        "request_id": "10000000-0000-4000-8000-000000000001",
        "message": "remind me tomorrow",
    })
    assert unsupported.status_code == 200
    assert "That capability is not available on the web yet." in _stream_text(unsupported)
    assert "Swico cannot complete this request through the current web route." not in unsupported.text

    safety = client.post("/api/web/chat/stream", headers=headers, json={
        "request_id": "10000000-0000-4000-8000-000000000002",
        "message": "I want to hurt myself",
    })
    assert safety.status_code == 200
    assert "safer alternative" in _stream_text(safety)
    assert "not available on the web" not in safety.text


def test_success_settles_and_duplicate_request_does_not_reinvoke_provider(client, monkeypatch):
    user = create_test_user(); _fund(int(user.id))
    calls = {"count": 0}
    def fake_stream(self, request, route, on_delta):
        calls["count"] += 1; on_delta("Hello")
        return AIProviderResponse(text="Hello", provider="openai", model=route.model, route=route.route, reason=route.reason, language="en", intent=route.intent, input_tokens=100, output_tokens=50, raw={"usage_actual":True})
    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", fake_stream)
    body = {"request_id":"ad235871-85a8-4fb5-b32f-0ae7343f7827","message":"Explain database indexes"}
    first = client.post("/api/web/chat/stream", headers=auth_headers("test-uid"), json=body)
    second = client.post("/api/web/chat/stream", headers=auth_headers("test-uid"), json=body)
    assert first.status_code == second.status_code == 200
    assert "event: done" in first.text and "event: done" in second.text
    assert calls["count"] == 1
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(UsageCharge.request_id == body["request_id"])).one()
        assert charge.status == "settled" and charge.debited_micros > 0
        assert get_wallet_summary(session, int(user.id))["reserved_micros"] == 0


def test_server_selected_tier_controls_chat_and_public_contracts_stay_private(
    client, monkeypatch,
):
    user = create_test_user("tier-chat", "tier-chat@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("SWICO_STANDARD_MODEL_PRIMARY", "gpt-5.6-terra")
    monkeypatch.setenv("SWICO_STANDARD_MODEL_FALLBACKS", "gpt-5.5")
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), assistant_tier="standard"))
        session.commit()
    captured = {}

    def fake_stream(self, request, route, on_delta):
        captured["metadata"] = dict(request.metadata)
        captured["candidates"] = list(route.model_candidates)
        on_delta("Private routing stayed private.")
        return AIProviderResponse(
            text="Private routing stayed private.", provider="openai",
            model=route.model_candidates[1], route=route.route, reason=route.reason,
            language="en", intent=route.intent, input_tokens=120, output_tokens=40,
            raw={"usage_actual": True},
        )

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete", fake_stream
    )
    request_id = "89bcd13b-edfd-49cb-af08-e576ef5af170"
    headers = auth_headers("tier-chat", "tier-chat@example.com")
    streamed = client.post(
        "/api/web/chat/stream", headers=headers,
        json={"request_id": request_id, "message": "Plan a migration safely"},
    )
    assert streamed.status_code == 200
    assert captured["metadata"]["swico_tier"] == "standard"
    assert captured["metadata"]["user_tier"] == "paid"
    assert captured["candidates"] == ["gpt-5.6-terra", "gpt-5.5"]
    usage_frame = next(
        line.removeprefix("data: ") for line in streamed.text.splitlines()
        if line.startswith("data: ") and '"tier_label"' in line
    )
    usage_payload = json.loads(usage_frame)
    assert usage_payload["tier"] == "standard"
    assert "provider" not in usage_payload and "model" not in usage_payload

    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == request_id
        )).one()
        assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "assistant",
        )).one()
        expected = price_usage("openai", "gpt-5.5", 120, 40)
        assert charge.swico_tier == assistant.swico_tier == "standard"
        assert charge.provider == "openai" and charge.model == "gpt-5.5"
        assert assistant.provider == "openai" and assistant.model == "gpt-5.5"
        assert charge.provider_cost_micros == expected.micros
        audit_snapshot = json.loads(charge.pricing_snapshot_json)
        assert audit_snapshot["model"] == "gpt-5.5"
        assert audit_snapshot["reservation"]["model"] == "gpt-5.6-terra"

    thread_id = json.loads(next(
        line.removeprefix("data: ") for line in streamed.text.splitlines()
        if line.startswith("data: ") and '"thread_id"' in line
    ))["thread_id"]
    messages = client.get(
        f"/api/web/threads/{thread_id}/messages", headers=headers
    ).json()["items"]
    public_assistant = next(item for item in messages if item["role"] == "assistant")
    assert public_assistant["tier"] == "standard"
    assert public_assistant["tier_label"] == "Swico"
    assert "provider" not in public_assistant and "model" not in public_assistant


def test_provider_failure_releases_complete_reservation(client, monkeypatch):
    user = create_test_user(); _fund(int(user.id))
    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("provider down")))
    request_id = "5b54081a-b15e-41df-a108-c1dfda9ef44f"
    response = client.post("/api/web/chat/stream", headers=auth_headers("test-uid"), json={"request_id":request_id,"message":"Explain database indexes"})
    assert response.status_code == 200 and "generation_failed" in response.text
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(UsageCharge.request_id == request_id)).one()
        assert charge.status == "released"
        assert get_wallet_summary(session, int(user.id))["reserved_micros"] == 0


def test_cancellation_before_output_releases_full_reservation(client, monkeypatch):
    user = create_test_user(); _fund(int(user.id))
    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", lambda *args, **kwargs: (_ for _ in ()).throw(GenerationCancelled()))
    request_id = "d80de6e0-c5cd-4de6-bf9a-9ce2f376a3c4"
    response = client.post("/api/web/chat/stream", headers=auth_headers("test-uid"), json={"request_id":request_id,"message":"Explain database indexes"})
    assert response.status_code == 200 and '"cancelled": true' in response.text
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(UsageCharge.request_id == request_id)).one()
        assert charge.status == "released" and charge.debited_micros == 0
        assert get_wallet_summary(session, int(user.id))["reserved_micros"] == 0


def test_cancellation_after_partial_output_settles_usage(client, monkeypatch):
    user = create_test_user(); _fund(int(user.id))
    def partial(self, request, route, on_delta):
        on_delta("Partial")
        raise GenerationCancelled(AIProviderResponse(text="Partial", provider="openai", model=route.model, route=route.route, reason=route.reason, language="en", intent=route.intent, input_tokens=100, output_tokens=12, raw={"usage_actual":False,"cancelled":True}))
    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", partial)
    request_id = "f51aa637-0dde-44f2-b352-e5aaf5c56469"
    response = client.post("/api/web/chat/stream", headers=auth_headers("test-uid"), json={"request_id":request_id,"message":"Explain database indexes"})
    assert response.status_code == 200 and '"cancelled": true' in response.text and "Partial" in response.text
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(UsageCharge.request_id == request_id)).one()
        assert charge.status == "settled" and charge.debited_micros > 0 and charge.usage_source == "estimated"
        assert get_wallet_summary(session, int(user.id))["reserved_micros"] == 0


def _temporary_upload(user_id: int, *, name: str = "report.pdf", text: str = "Secret quarterly revenue was 42.") -> EphemeralUpload:
    upload = EphemeralUpload(
        id="70000000-0000-4000-8000-000000000001",
        owner_user_id=user_id,
        name=name,
        extension=".pdf",
        media_type="application/pdf",
        size_bytes=1234,
        created_at=utc_iso(),
        expires_at=utc_iso(datetime.now(timezone.utc) + timedelta(minutes=10)),
        chunks=[ExtractedChunk(text=text, source="page 3")],
        source_locators=["page 3"],
        warnings=[],
    )
    get_upload_store().put(upload)
    return upload


def test_web_followup_context_is_paired_and_profile_context_is_private(client, monkeypatch):
    user = create_test_user("context-user", "context-user@example.com")
    _fund(int(user.id))
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Context")
        session.add(thread); session.flush()
        session.add(WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user", content="What is an index?",
            request_id="71000000-0000-4000-8000-000000000001", status="complete",
        ))
        session.add(WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant", content="It speeds database lookups.",
            request_id="71000000-0000-4000-8000-000000000001", status="complete",
        ))
        session.add(UserProfile(
            user_id=int(user.id),
            answers_json=json.dumps({
                "age_group": "13_17", "communication_tone": "friendly", "answer_length": "short",
                "preferred_language": "en", "occupation": "student", "assistant_persona": "coach",
                "main_goal": "learn", "dislikes": "jargon",
            }),
            profile_summary="A student who prefers concise explanations.",
        ))
        session.commit(); thread_id = thread.id
    captured = {}

    def fake_stream(self, request, route, on_delta):
        captured["context"] = request.context_turns
        captured["metadata"] = request.metadata
        on_delta("Follow-up answer")
        return AIProviderResponse(
            text="Follow-up answer", provider="openai", model=route.model, route=route.route,
            reason=route.reason, language="en", intent=route.intent, input_tokens=80,
            output_tokens=10, raw={"usage_actual": True},
        )

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", fake_stream)
    response = client.post("/api/web/chat/stream", headers=auth_headers("context-user", "context-user@example.com"), json={
        "request_id": "71000000-0000-4000-8000-000000000002",
        "thread_id": thread_id,
        "message": "Explain that more simply",
    })
    assert response.status_code == 200
    assert captured["context"] == [{
        "user": "What is an index?", "assistant": "It speeds database lookups.",
    }]
    assert captured["metadata"]["age_group"] == "13_17"
    assert "student" in captured["metadata"]["profile_prompt_context"]
    assert "profile_prompt_context" not in response.text


def test_attachment_context_affects_reservation_but_only_metadata_is_persisted(client, monkeypatch):
    user = create_test_user("attachment-chat", "attachment-chat@example.com")
    _fund(int(user.id))
    upload = _temporary_upload(int(user.id))
    captured = {}
    import app.web_api.chat_service as chat_service
    original_reserve = chat_service.reserve_price

    def capture_reserve(provider, model, input_tokens, output_tokens):
        captured["reservation_input_tokens"] = input_tokens
        return original_reserve(provider, model, input_tokens, output_tokens)

    def fake_stream(self, request, route, on_delta):
        captured["request"] = request
        on_delta("Revenue was 42 [report.pdf, page 3].")
        return AIProviderResponse(
            text="Revenue was 42 [report.pdf, page 3].", provider="openai", model=route.model,
            route=route.route, reason=route.reason, language="en", intent=route.intent,
            input_tokens=100, output_tokens=20, raw={"usage_actual": True},
        )

    monkeypatch.setattr(chat_service, "reserve_price", capture_reserve)
    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", fake_stream)
    request_id = "72000000-0000-4000-8000-000000000001"
    response = client.post("/api/web/chat/stream", headers=auth_headers("attachment-chat", "attachment-chat@example.com"), json={
        "request_id": request_id, "message": "What was revenue?", "attachment_ids": [upload.id],
    })
    assert response.status_code == 200
    assert "Secret quarterly revenue was 42." in captured["request"].metadata["attachment_prompt_context"]
    assert captured["reservation_input_tokens"] > 5
    with SessionLocal() as session:
        user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == request_id, WebChatMessage.role == "user",
        )).one()
        metadata = json.loads(user_message.metadata_json)
        assert metadata["attachments"][0]["name"] == "report.pdf"
        assert "chunks" not in user_message.metadata_json
        assert "Secret quarterly" not in user_message.metadata_json
        thread_id = user_message.thread_id
    public = client.get(
        f"/api/web/threads/{thread_id}/messages",
        headers=auth_headers("attachment-chat", "attachment-chat@example.com"),
    ).json()["items"]
    public_user = next(item for item in public if item["role"] == "user")
    assert public_user["attachments"][0]["status"] == "ready"
    assert "chunks" not in json.dumps(public_user)
    assert "Secret quarterly" not in json.dumps(public_user)


def test_attachment_only_message_and_idempotent_replay_do_not_double_charge(client, monkeypatch):
    user = create_test_user("attachment-replay", "attachment-replay@example.com")
    _fund(int(user.id))
    upload = _temporary_upload(int(user.id), name="budget.pdf")
    calls = {"count": 0}

    def fake_stream(self, request, route, on_delta):
        calls["count"] += 1
        assert request.message == "Review and summarize the attached document."
        on_delta("Summary")
        return AIProviderResponse(
            text="Summary", provider="openai", model=route.model, route=route.route,
            reason=route.reason, language="en", intent=route.intent,
            input_tokens=80, output_tokens=10, raw={"usage_actual": True},
        )

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", fake_stream)
    body = {
        "request_id": "73000000-0000-4000-8000-000000000001",
        "message": "", "attachment_ids": [upload.id],
    }
    headers = auth_headers("attachment-replay", "attachment-replay@example.com")
    first = client.post("/api/web/chat/stream", headers=headers, json=body)
    second = client.post("/api/web/chat/stream", headers=headers, json=body)
    assert first.status_code == second.status_code == 200 and calls["count"] == 1
    with SessionLocal() as session:
        charges = session.exec(select(UsageCharge).where(UsageCharge.request_id == body["request_id"])).all()
        user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id == body["request_id"], WebChatMessage.role == "user",
        )).one()
        thread = session.get(WebChatThread, user_message.thread_id)
        assert len(charges) == 1
        assert user_message.content == "Attached: budget.pdf"
        assert thread is not None and thread.title == "budget.pdf"
