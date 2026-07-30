from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from app.ai.types import AIProviderResponse, AIRequest
from app.ai.providers.base import (
    GenerationCancelled, GenerationIncomplete, ProviderStreamInterrupted,
)
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
from app.web_api.chat_service import (
    AttachmentRequestError, CompletedWebMessage,
    execute_web_turn,
    prepare_web_turn,
)


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


def _completed_provider_response(self, request, route, on_delta):
    text = "FIFO processes the earliest queued item first."
    on_delta(text)
    return AIProviderResponse(
        text=text,
        provider="openai",
        model=route.model,
        route=route.route,
        reason=route.reason,
        language="en",
        intent=route.intent,
        input_tokens=24,
        output_tokens=12,
        raw={
            "usage_actual": True,
            "provider_attempts": 1,
            "provider_calls_with_usage": 1,
            "finish_reason": "stop",
            "truncated": False,
            "completion_status": "complete",
        },
    )


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
    # Historical/legacy `voice` metadata is presented as explicit dictation
    # without rewriting the stored audit rows.
    assert all(item["input_mode"] == "dictation" for item in serialized)
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


def test_public_realtime_voice_metadata_is_still_billed_only_to_chat(client, monkeypatch):
    monkeypatch.setenv("WEB_SEPARATE_VOICE_CREDITS_ENABLED", "true")
    user = create_test_user("spoof-bucket", "spoof-bucket@example.com")
    _fund(int(user.id))
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        voice_order = PaymentOrder(
            user_id=int(user.id), receipt="fund-spoof-voice",
            provider_order_id="fund-order-spoof-voice", gross_amount_paise=1000,
            credited_amount_micros=credit, platform_share_paise=platform,
            credit_bucket="voice", status="captured",
        )
        session.add(voice_order); session.flush(); credit_payment_once(session, voice_order); session.commit()

    def complete(self, request, route, on_delta):
        on_delta("Server-authoritative billing.")
        return AIProviderResponse(
            text="Server-authoritative billing.", provider="openai", model=route.model,
            route=route.route, reason=route.reason, language="en", intent=route.intent,
            input_tokens=30, output_tokens=10, raw={"usage_actual": True},
        )

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", complete)
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("spoof-bucket", "spoof-bucket@example.com"),
        json={
            "request_id": "33333333-3333-4333-8333-333333333334",
            "message": "Explain why authoritative billing matters",
            "input_mode": "realtime_voice",
            "voice_turn_id": "33333333-3333-4333-8333-333333333335",
        },
    )
    assert response.status_code == 200
    assert _sse_events(response, "done")[0]["billing_credit_bucket"] == "chat"
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == "33333333-3333-4333-8333-333333333334"
        )).one()
        assert charge.usage_kind == "chat" and charge.credit_bucket == "chat"
        assert get_wallet_summary(session, int(user.id), credit_bucket="chat")["balance_micros"] < credit
        assert get_wallet_summary(session, int(user.id), credit_bucket="voice")["balance_micros"] == credit


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

    unsupported_tts = client.post("/api/web/chat/stream", headers=headers, json={
        "request_id": "10000000-0000-4000-8000-000000000003",
        "message": "read aloud this paragraph",
    })
    assert unsupported_tts.status_code == 200
    assert "That capability is not available on the web yet." in _stream_text(unsupported_tts)
    with SessionLocal() as session:
        assert session.exec(select(UsageCharge).where(
            UsageCharge.request_id == "10000000-0000-4000-8000-000000000003"
        )).first() is None

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


def test_generation_incomplete_is_retryable_and_releases_reservation(
    client, monkeypatch
):
    user = create_test_user()
    _fund(int(user.id))
    calls = {"count": 0}

    def incomplete(*_args, **_kwargs):
        calls["count"] += 1
        raise GenerationIncomplete(
            completion_status="incomplete",
            incomplete_reason="max_output_tokens",
            finish_reason="length",
            input_tokens=100,
            output_tokens=320,
            reasoning_tokens=320,
            visible_characters=0,
            max_output_tokens=320,
            provider_usage_received=True,
        )

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        incomplete,
    )
    request_id = "0d0aa607-1d4a-47b3-b045-a411ca60e9f3"
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("test-uid"),
        json={
            "request_id": request_id,
            "message": "Give me a complete database indexing roadmap",
        },
    )

    assert response.status_code == 200
    errors = _sse_events(response, "error")
    assert errors == [{
        "code": "generation_incomplete",
        "message": (
            "Swico reached its response limit before it could start the "
            "answer. Please retry."
        ),
    }]
    assert calls["count"] == 1
    with SessionLocal() as session:
        charge = session.exec(
            select(UsageCharge).where(
                UsageCharge.request_id == request_id
            )
        ).one()
        user_message = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "user",
            )
        ).one()
        assistant = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "assistant",
            )
        ).first()
        assert charge.status == "released"
        assert charge.debited_micros == 0
        assert user_message.status == "retryable"
        assert assistant is None
        assert get_wallet_summary(session, int(user.id))[
            "reserved_micros"
        ] == 0


def test_partial_transport_interruption_is_retryable_without_post_turn_work(
    client, monkeypatch
):
    user = create_test_user("stream-interrupted", "stream-interrupted@example.com")
    _fund(int(user.id))
    calls = {"count": 0}

    def interrupted(self, request, route, on_delta):
        calls["count"] += 1
        on_delta("Partial visible answer")
        partial = AIProviderResponse(
            text="Partial visible answer",
            provider="openai",
            model=route.model,
            route=route.route,
            reason=route.reason,
            language="en",
            intent=route.intent,
            input_tokens=40,
            output_tokens=5,
            raw={
                "usage_actual": False,
                "provider_attempts": 1,
                "provider_calls_with_usage": 0,
                "interrupted": True,
            },
        )
        raise ProviderStreamInterrupted(
            response=partial,
            provider_attempts=1,
            visible_output_emitted=True,
            provider_usage_received=False,
        )

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        interrupted,
    )
    monkeypatch.setattr(
        "app.web_api.chat_service._run_post_turn_operation",
        lambda **_kwargs: pytest.fail(
            "interrupted turns must not run post-turn work"
        ),
    )
    request_id = "7da88957-837a-4af4-b82c-2ba502c2804a"

    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("stream-interrupted", "stream-interrupted@example.com"),
        json={
            "request_id": request_id,
            "message": "Explain database indexes",
        },
    )

    assert response.status_code == 200
    assert _stream_text(response) == "Partial visible answer"
    assert _sse_events(response, "error") == [{
        "code": "stream_interrupted",
        "message": "The connection ended before Swico finished. Retry.",
    }]
    assert calls["count"] == 1
    with SessionLocal() as session:
        charge = session.exec(
            select(UsageCharge).where(UsageCharge.request_id == request_id)
        ).one()
        user_message = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "user",
            )
        ).one()
        assistant = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "assistant",
            )
        ).first()
        assert charge.status == "released"
        assert user_message.status == "retryable"
        assert assistant is None
    from app.web_api.router import _active_generations
    assert request_id not in _active_generations


def test_web_stream_emits_configured_heartbeat(client, monkeypatch):
    user = create_test_user("heartbeat-user", "heartbeat-user@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("WEB_SSE_HEARTBEAT_SECONDS", "0.01")

    def delayed(self, request, route, on_delta):
        time.sleep(0.04)
        return _completed_provider_response(self, request, route, on_delta)

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        delayed,
    )

    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("heartbeat-user", "heartbeat-user@example.com"),
        json={
            "request_id": "16627251-8bf0-4ac8-8818-2d9db65bfda1",
            "message": "Explain database indexes",
        },
    )

    assert response.status_code == 200
    assert ": keep-alive\n\n" in response.text
    assert _sse_events(response, "done")


def test_continuation_is_separate_billable_segment_and_consumes_parent_once(
    client, monkeypatch
):
    user = create_test_user("continue-chain-api", "continue-chain-api@example.com")
    _fund(int(user.id))
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Continuation")
        session.add(thread); session.flush()
        original = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="Build an HTML page.\n1. Preserve indentation.",
            request_id="continue-root-request", status="complete",
        )
        parent = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="```html\n  <main>",
            request_id="continue-root-request", status="complete",
            metadata_json=json.dumps({
                "truncated": True,
                "completion_status": "incomplete",
                "answer_class": "long_form",
            }),
        )
        session.add(original); session.add(parent); session.commit()
        thread_id, parent_id = thread.id, parent.id

    calls = {"count": 0}

    def complete_continuation(self, request, route, on_delta):
        calls["count"] += 1
        text = '  <section>Safe</section>\n'
        on_delta(text)
        return AIProviderResponse(
            text=text, provider="openai", model=route.model,
            route=route.route, reason=route.reason, language="en",
            intent=route.intent, input_tokens=80, output_tokens=20,
            raw={
                "usage_actual": True, "provider_attempts": 1,
                "provider_calls_with_usage": 1, "finish_reason": "stop",
                "truncated": True, "completion_status": "incomplete",
                "incomplete_reason": "unmatched_code_fence",
            },
        )

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        complete_continuation,
    )
    monkeypatch.setenv("WEB_MEMORY_FACT_RANKING_ENABLED", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service.memory_enabled",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.retrieve_memory",
        lambda *_args, **_kwargs: pytest.fail(
            "continuation controls must not retrieve cross-thread memory"
        ),
    )
    monkeypatch.setattr(
        "app.web_api.chat_service._cache_response",
        lambda *_args, **_kwargs: pytest.fail(
            "continuation controls must not read the global answer cache"
        ),
    )
    monkeypatch.setattr(
        "app.web_api.chat_service._run_post_turn_operation",
        lambda **_kwargs: pytest.fail(
            "continuation controls must not run post-turn work"
        ),
    )
    headers = auth_headers("continue-chain-api", "continue-chain-api@example.com")
    response = client.post(
        "/api/web/chat/stream",
        headers=headers,
        json={
            "request_id": "fa883e19-ddbb-492b-a921-d851cabf189a",
            "thread_id": thread_id,
            "message": "Continue response",
            "continue_message_id": parent_id,
        },
    )

    assert response.status_code == 200
    done = _sse_events(response, "done")[0]
    assert done["continuation_parent_message_id"] == parent_id
    assert done["parent_can_continue"] is False
    assert done["continuation_render_prefix"] == "```html\n"
    assert done["can_continue"] is True
    assert calls["count"] == 1

    listed = client.get(
        f"/api/web/threads/{thread_id}/messages", headers=headers
    ).json()["items"]
    assert all(item["content"] != "Continue response" for item in listed)
    assistants = [item for item in listed if item["role"] == "assistant"]
    assert len(assistants) == 2
    assert assistants[0]["can_continue"] is False
    assert assistants[1]["can_continue"] is True
    assert assistants[1]["continuation_render_prefix"] == "```html\n"

    duplicate = client.post(
        "/api/web/chat/stream",
        headers=headers,
        json={
            "request_id": "bb03ca68-7951-46fc-8f5f-e71f1a678513",
            "thread_id": thread_id,
            "message": "Continue response",
            "continue_message_id": parent_id,
        },
    )
    assert duplicate.status_code == 409
    assert calls["count"] == 1
    with SessionLocal() as session:
        parent = session.get(WebChatMessage, parent_id)
        parent_metadata = json.loads(parent.metadata_json)
        assert parent_metadata["continuation_consumed"] is True
        assert parent_metadata["continued_by_message_id"] == assistants[1]["id"]
        controls = session.exec(select(WebChatMessage).where(
            WebChatMessage.thread_id == thread_id,
            WebChatMessage.role == "user",
        )).all()
        assert any(
            json.loads(row.metadata_json).get("is_continuation_control")
            for row in controls
        )


def test_failed_continuation_releases_parent_claim_for_retry(client, monkeypatch):
    user = create_test_user("continue-retry", "continue-retry@example.com")
    _fund(int(user.id))
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Retry continuation")
        session.add(thread); session.flush()
        session.add(WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="Write Python", request_id="retry-root", status="complete",
        ))
        parent = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="```python\nvalue =", request_id="retry-root",
            status="complete", metadata_json=json.dumps({"truncated": True}),
        )
        session.add(parent); session.commit()
        thread_id, parent_id = thread.id, parent.id

    calls = {"count": 0}

    def fail_once(self, request, route, on_delta):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("provider failed")
        on_delta(" 1\n```")
        return AIProviderResponse(
            text=" 1\n```", provider="openai", model=route.model,
            route=route.route, reason=route.reason, language="en",
            intent=route.intent, input_tokens=20, output_tokens=3,
            raw={"usage_actual": True, "provider_attempts": 1,
                 "provider_calls_with_usage": 1, "finish_reason": "stop",
                 "truncated": False, "completion_status": "complete"},
        )

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        fail_once,
    )
    headers = auth_headers("continue-retry", "continue-retry@example.com")
    first = client.post("/api/web/chat/stream", headers=headers, json={
        "request_id": "2882f8d6-f0f8-43cf-bd26-a56dc94affef",
        "thread_id": thread_id, "message": "Continue response",
        "continue_message_id": parent_id,
    })
    assert "generation_failed" in first.text
    with SessionLocal() as session:
        metadata = json.loads(session.get(WebChatMessage, parent_id).metadata_json)
        assert metadata["continuation_consumed"] is False

    second = client.post("/api/web/chat/stream", headers=headers, json={
        "request_id": "0bd0d9b6-c8b5-4578-8202-3cfdf36e577f",
        "thread_id": thread_id, "message": "Continue response",
        "continue_message_id": parent_id,
    })
    assert _sse_events(second, "done")
    assert calls["count"] == 2


def test_cancelled_continuation_releases_parent_claim_and_reservation():
    user = create_test_user(
        "continue-cancelled", "continue-cancelled@example.com"
    )
    _fund(int(user.id))
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Cancelled continuation")
        session.add(thread); session.flush()
        session.add(WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="Build a shell script", request_id="cancel-root",
            status="complete",
        ))
        parent = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="```bash\necho", request_id="cancel-root",
            status="complete", metadata_json=json.dumps({"truncated": True}),
        )
        session.add(parent); session.commit()
        thread_id, parent_id = thread.id, parent.id

    prepared = prepare_web_turn(
        user_id=int(user.id), message="Continue response",
        request_id="733ef3f4-667c-481c-be38-d4d65fe508ee",
        thread_id=thread_id, reply_language="en",
        continue_message_id=parent_id,
    )

    class Provider:
        def stream_complete(self, _request, _route, _on_delta):
            raise GenerationCancelled()

    with pytest.raises(GenerationCancelled):
        execute_web_turn(
            prepared, providers={"openai": Provider()},
            on_delta=lambda _value: None,
        )
    with SessionLocal() as session:
        parent = session.get(WebChatMessage, parent_id)
        parent_metadata = json.loads(parent.metadata_json)
        assert parent_metadata["continuation_consumed"] is False
        control = session.exec(select(WebChatMessage).where(
            WebChatMessage.request_id
            == "733ef3f4-667c-481c-be38-d4d65fe508ee",
            WebChatMessage.role == "user",
        )).one()
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id
            == "733ef3f4-667c-481c-be38-d4d65fe508ee",
        )).one()
        assert control.status == "retryable"
        assert charge.status == "released"


def test_active_continuation_claim_prevents_duplicate_billing_and_provider_call():
    user = create_test_user(
        "continue-active-claim", "continue-active-claim@example.com"
    )
    _fund(int(user.id))
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Active continuation")
        session.add(thread); session.flush()
        session.add(WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="user",
            content="Build a SQL example", request_id="active-root",
            status="complete",
        ))
        parent = WebChatMessage(
            thread_id=thread.id, user_id=int(user.id), role="assistant",
            content="```sql\nSELECT", request_id="active-root",
            status="complete", metadata_json=json.dumps({"truncated": True}),
        )
        session.add(parent); session.commit()
        thread_id, parent_id = thread.id, parent.id

    prepared = prepare_web_turn(
        user_id=int(user.id), message="Continue response",
        request_id="78e631d6-d122-4644-a454-c251b54bdde4",
        thread_id=thread_id, reply_language="en",
        continue_message_id=parent_id,
    )
    with pytest.raises(AttachmentRequestError) as caught:
        prepare_web_turn(
            user_id=int(user.id), message="Continue response",
            request_id="d36d3762-5067-44a1-9bfa-13c3fdb0aad7",
            thread_id=thread_id, reply_language="en",
            continue_message_id=parent_id,
        )
    assert caught.value.code == "continuation_already_claimed"

    calls = {"count": 0}

    class Provider:
        def stream_complete(self, request, route, on_delta):
            calls["count"] += 1
            return _completed_provider_response(self, request, route, on_delta)

    execute_web_turn(
        prepared, providers={"openai": Provider()},
        on_delta=lambda _value: None,
    )
    assert calls["count"] == 1
    with SessionLocal() as session:
        charges = session.exec(select(UsageCharge).where(
            UsageCharge.request_id.in_([
                "78e631d6-d122-4644-a454-c251b54bdde4",
                "d36d3762-5067-44a1-9bfa-13c3fdb0aad7",
            ])
        )).all()
        assert len(charges) == 1
        assert charges[0].status == "settled"


def test_closed_sse_generator_observes_worker_exception_and_cleans_active_request(
    monkeypatch,
):
    from fastapi import Request

    from app.auth import AuthUser
    from app.web_api.router import _active_generations, chat_stream
    from app.web_api.schemas import WebChatRequest

    user = create_test_user("closed-stream", "closed-stream@example.com")
    _fund(int(user.id))
    request_id = "7319ef7a-1883-4d4b-9862-fabb6fa78cc8"

    def delayed_failure(*_args, **_kwargs):
        time.sleep(0.04)
        raise RuntimeError("worker failed after generator close")

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        delayed_failure,
    )
    unhandled = []

    async def exercise() -> None:
        loop = asyncio.get_running_loop()
        loop.set_exception_handler(
            lambda _loop, context: unhandled.append(context)
        )

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        incoming = Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/web/chat/stream",
                "headers": [],
            },
            receive=receive,
        )
        response = await chat_stream(
            WebChatRequest(
                request_id=request_id,
                message="Explain database indexes",
            ),
            incoming,
            AuthUser(
                firebase_uid="closed-stream",
                email="closed-stream@example.com",
                email_verified=True,
            ),
        )
        iterator = response.body_iterator
        await anext(iterator)
        await iterator.aclose()
        await asyncio.sleep(0.1)

    asyncio.run(exercise())

    assert request_id not in _active_generations
    assert not any(
        context.get("message") == "Task exception was never retrieved"
        for context in unhandled
    )
    with SessionLocal() as session:
        charge = session.exec(
            select(UsageCharge).where(UsageCharge.request_id == request_id)
        ).one()
        user_message = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "user",
            )
        ).one()
        assert charge.status == "released"
        assert user_message.status == "retryable"


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
    assert "student" not in captured["metadata"]["profile_prompt_context"]
    assert "minor_safety" in captured["metadata"]["profile_prompt_context"]
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


def test_post_turn_cache_record_failure_cannot_break_committed_sse(
    client, monkeypatch,
):
    user = create_test_user("post-cache-failure", "post-cache-failure@example.com")
    _fund(int(user.id))
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        _completed_provider_response,
    )
    recorder_calls = {"count": 0}

    def fail_record(*_args, **_kwargs):
        recorder_calls["count"] += 1
        raise RuntimeError("cache recorder unavailable")

    monkeypatch.setattr(
        "app.global_qa_cache.record_backend_openai_answer",
        fail_record,
    )
    request_id = "74000000-0000-4000-8000-000000000001"
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("post-cache-failure", "post-cache-failure@example.com"),
        json={"request_id": request_id, "message": "Explain FIFO queue ordering"},
    )
    assert response.status_code == 200
    assert _sse_events(response, "usage")
    assert _sse_events(response, "wallet")
    assert _sse_events(response, "done")
    assert not _sse_events(response, "error")
    assert "generation_failed" not in response.text
    with SessionLocal() as session:
        assistant = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "assistant",
            )
        ).one()
        charge = session.exec(
            select(UsageCharge).where(UsageCharge.request_id == request_id)
        ).one()
    assert assistant.status == "complete"
    assert charge.status == "settled"
    assert recorder_calls["count"] == 1


def test_structurally_truncated_answer_is_saved_billed_and_not_post_processed(
    client, monkeypatch,
):
    user = create_test_user(
        "local-truncation", "local-truncation@example.com"
    )
    _fund(int(user.id))
    monkeypatch.setenv("WEB_POST_TURN_DISTILLATION_ENABLED", "true")
    monkeypatch.setenv("WEB_MEMORY_FACT_RANKING_ENABLED", "true")
    provider_calls = {"count": 0}
    post_turn_calls = {
        "cache": 0,
        "memory": 0,
        "distillation": 0,
        "embedding": 0,
    }
    partial = (
        "### Cell 3 — Create and use the local SQLite database\n\n"
        "```python"
    )

    def truncated_stream(self, request, route, on_delta):
        provider_calls["count"] += 1
        on_delta(partial)
        return AIProviderResponse(
            text=partial,
            provider="openai",
            model=route.model,
            route=route.route,
            reason=route.reason,
            language="en",
            intent=route.intent,
            input_tokens=90,
            output_tokens=240,
            raw={
                "usage_actual": True,
                "provider_attempts": 1,
                "provider_calls_with_usage": 1,
                "finish_reason": "local_incomplete",
                "provider_finish_reason": "stop",
                "truncated": True,
                "completion_status": "incomplete",
                "incomplete_reason": "empty_final_code_block",
            },
        )

    def counted(name):
        def callback(*_args, **_kwargs):
            post_turn_calls[name] += 1
        return callback

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        truncated_stream,
    )
    monkeypatch.setattr(
        "app.global_qa_cache.record_backend_openai_answer",
        counted("cache"),
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.write_turn_memory",
        counted("memory"),
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.enqueue_post_turn_distillation",
        counted("distillation"),
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.enqueue_memory_embedding_backfill",
        counted("embedding"),
    )
    request_id = "74000000-0000-4000-8000-000000000005"
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers(
            "local-truncation", "local-truncation@example.com"
        ),
        json={
            "request_id": request_id,
            "message": "Give me a complete SQLite implementation tutorial",
        },
    )

    assert response.status_code == 200
    done = _sse_events(response, "done")
    assert done and done[0]["truncated"] is True
    assert done[0]["can_continue"] is True
    assert provider_calls["count"] == 1
    assert post_turn_calls == {
        "cache": 0,
        "memory": 0,
        "distillation": 0,
        "embedding": 0,
    }
    with SessionLocal() as session:
        assistants = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "assistant",
            )
        ).all()
        charges = session.exec(
            select(UsageCharge).where(
                UsageCharge.request_id == request_id
            )
        ).all()
        assert len(assistants) == 1
        assert assistants[0].status == "complete"
        assert assistants[0].content == partial
        metadata = json.loads(assistants[0].metadata_json)
        assert metadata["truncated"] is True
        assert metadata["completion_status"] == "incomplete"
        assert metadata["cache_eligible"] is False
        assert metadata["cache_scope_reason"] == "truncated_response"
        assert len(charges) == 1
        assert charges[0].status == "settled"
        assert charges[0].output_tokens == 240


@pytest.mark.parametrize(
    ("flag_name", "enqueue_name"),
    [
        (
            "WEB_POST_TURN_DISTILLATION_ENABLED",
            "enqueue_post_turn_distillation",
        ),
        (
            "WEB_MEMORY_FACT_RANKING_ENABLED",
            "enqueue_memory_embedding_backfill",
        ),
    ],
)
def test_post_turn_enqueue_failure_leaves_answer_and_single_charge(
    client, monkeypatch, flag_name, enqueue_name,
):
    suffix = "distill" if "distillation" in enqueue_name else "embedding"
    user = create_test_user(
        f"post-enqueue-{suffix}", f"post-enqueue-{suffix}@example.com"
    )
    _fund(int(user.id))
    monkeypatch.setenv(flag_name, "true")
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        _completed_provider_response,
    )
    calls = {"count": 0}

    def fail_enqueue(*_args, **_kwargs):
        calls["count"] += 1
        raise RuntimeError("post-turn queue unavailable")

    monkeypatch.setattr(
        f"app.web_api.chat_service.{enqueue_name}",
        fail_enqueue,
    )
    request_id = (
        "74000000-0000-4000-8000-000000000002"
        if suffix == "distill"
        else "74000000-0000-4000-8000-000000000004"
    )
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers(f"post-enqueue-{suffix}", f"post-enqueue-{suffix}@example.com"),
        json={"request_id": request_id, "message": "Explain FIFO queue ordering"},
    )
    assert response.status_code == 200
    assert _sse_events(response, "done")
    assert not _sse_events(response, "error")
    with SessionLocal() as session:
        assistants = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "assistant",
            )
        ).all()
        charges = session.exec(
            select(UsageCharge).where(UsageCharge.request_id == request_id)
        ).all()
    assert len(assistants) == 1 and assistants[0].status == "complete"
    assert len(charges) == 1 and charges[0].status == "settled"
    assert calls["count"] == 1


def test_idempotent_replay_returns_transport_snapshot_and_one_charge(monkeypatch):
    user = create_test_user("snapshot-replay", "snapshot-replay@example.com")
    _fund(int(user.id))
    request_id = "74000000-0000-4000-8000-000000000003"
    first = prepare_web_turn(
        user_id=int(user.id),
        message="Explain FIFO queue ordering",
        request_id=request_id,
        thread_id=None,
        reply_language="en",
    )
    completed = execute_web_turn(
        first,
        providers={
            "openai": type(
                "Provider",
                (),
                {"stream_complete": _completed_provider_response},
            )()
        },
        on_delta=lambda _value: None,
    )
    replay = prepare_web_turn(
        user_id=int(user.id),
        message="Explain FIFO queue ordering",
        request_id=request_id,
        thread_id=completed.thread_id,
        reply_language="en",
    )
    replayed = execute_web_turn(replay, on_delta=lambda _value: None)
    assert isinstance(completed.message, CompletedWebMessage)
    assert isinstance(replayed.message, CompletedWebMessage)
    assert not isinstance(replayed.message, WebChatMessage)
    assert replayed.message.id == completed.message.id
    with SessionLocal() as session:
        assert len(
            session.exec(
                select(UsageCharge).where(UsageCharge.request_id == request_id)
            ).all()
        ) == 1


def test_json_time_brand_and_topup_routes_make_zero_provider_calls(
    client, monkeypatch,
):
    create_test_user("deterministic-routing", "deterministic-routing@example.com")
    monkeypatch.setenv("WEB_DETERMINISTIC_TOOLS_ENABLED", "true")
    monkeypatch.setenv("WEB_RESPONSE_PROVENANCE_ENABLED", "true")
    calls = {"count": 0}

    def unexpected_provider(*_args, **_kwargs):
        calls["count"] += 1
        raise AssertionError("deterministic route called a chat provider")

    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        unexpected_provider,
    )
    monkeypatch.setattr(
        "app.ai.providers.sarvam_provider.SarvamProvider.stream_complete",
        unexpected_provider,
    )
    cases = [
        (
            "Validate this JSON: {\"name\":\"Swico\",\"active\":true}",
            "Valid JSON:",
        ),
        ("What time is it?", "Asia/Kolkata"),
        ("Who created Swico?", "CEO Jeyanth"),
        ("What can Swico do?", "Swico supports"),
        ("Who is your creator?", "CEO Jeyanth"),
        ("Recharge panna eppadi?", "Add credits"),
        ("How do I recharge my Swico balance?", "Add credits"),
    ]
    headers = auth_headers(
        "deterministic-routing", "deterministic-routing@example.com"
    )
    for index, (message, expected) in enumerate(cases, start=1):
        response = client.post(
            "/api/web/chat/stream",
            headers=headers,
            json={
                "request_id": f"76000000-0000-4000-8000-{index:012d}",
                "message": message,
            },
        )
        assert response.status_code == 200
        assert expected in _stream_text(response)
        assert "backend_tool" in response.text
        assert not _sse_events(response, "error")
    assert calls["count"] == 0
