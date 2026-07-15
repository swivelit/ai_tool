from __future__ import annotations

from app.ai.types import AIProviderResponse, AIRequest
from app.billing.pricing import calculate_topup
from app.billing.service import credit_payment_once, get_wallet_summary
from app.database import SessionLocal
from app.models import PaymentOrder, UsageCharge, WebChatThread
from sqlmodel import select
from app.ai import orchestrator
from tests.conftest import auth_headers, create_test_user


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


def _fund(user_id: int):
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        order = PaymentOrder(user_id=user_id, receipt=f"fund-{user_id}", provider_order_id=f"fund-order-{user_id}", gross_amount_paise=1000, credited_amount_micros=credit, platform_share_paise=platform, status="captured")
        session.add(order); session.flush(); credit_payment_once(session, order); session.commit()


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
