from datetime import timedelta
from uuid import uuid4

import pytest
from sqlmodel import select

from app.database import SessionLocal
from app.models import UsageCharge, User, WebChatThread, WebGuestSession, WebUsagePreferences
from app.time_utils import utc_now
from app.web_api.chat_service import prepare_web_turn
from app.web_api.guest_service import _token_digest
from app.web_api.router import SwicoTierUnavailableError


def create_guest(client, monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    response = client.post("/api/web/guest/session")
    assert response.status_code == 200, response.text
    return response.json()


def test_guest_session_is_public_and_stores_only_a_digest(client, monkeypatch):
    data = create_guest(client, monkeypatch)
    token = data["guest_token"]
    assert len(token) >= 64
    assert data["assistant"] == {"tier": "free", "tier_label": "Swico Free"}
    with SessionLocal() as session:
        row = session.exec(select(WebGuestSession)).one()
        assert row.token_digest == _token_digest(token)
        assert row.token_digest != token
        user = session.get(User, row.user_id)
        preferences = session.exec(select(WebUsagePreferences).where(
            WebUsagePreferences.user_id == row.user_id,
        )).one()
        assert user is not None and user.firebase_uid is None and user.email is None
        assert preferences.assistant_tier == "free"
        assert preferences.memory_enabled is False


def test_guest_endpoints_reject_missing_invalid_and_expired_tokens(client, monkeypatch):
    data = create_guest(client, monkeypatch)
    body = {"request_id": str(uuid4()), "message": "hello", "input_mode": "text"}
    assert client.post("/api/web/guest/chat/stream", json=body).status_code == 401
    assert client.post(
        "/api/web/guest/chat/stream", json=body,
        headers={"X-Swico-Guest-Token": "x" * 80},
    ).status_code == 401
    with SessionLocal() as session:
        row = session.exec(select(WebGuestSession)).one()
        row.expires_at = utc_now() - timedelta(seconds=1)
        session.add(row)
        session.commit()
    assert client.post(
        "/api/web/guest/chat/stream", json=body,
        headers={"X-Swico-Guest-Token": data["guest_token"]},
    ).status_code == 401


def test_revoked_guest_token_is_rejected(client, monkeypatch):
    data = create_guest(client, monkeypatch)
    with SessionLocal() as session:
        row = session.exec(select(WebGuestSession)).one()
        row.revoked_at = utc_now()
        session.add(row)
        session.commit()
    response = client.post(
        "/api/web/guest/chat/stream",
        json={"request_id": str(uuid4()), "message": "hello", "input_mode": "text"},
        headers={"X-Swico-Guest-Token": data["guest_token"]},
    )
    assert response.status_code == 401


def test_guest_session_creation_is_admission_limited(client, monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "true")
    monkeypatch.setenv("SWICO_GUEST_SESSION_CREATION_RATE_LIMIT_PER_HOUR", "1")
    assert client.post("/api/web/guest/session").status_code == 200
    response = client.post("/api/web/guest/session")
    assert response.status_code == 429
    assert response.headers["retry-after"] == "3600"


def test_guest_session_respects_the_free_safety_switch(client, monkeypatch):
    monkeypatch.setenv("SWICO_FREE_ENABLED", "false")
    response = client.post("/api/web/guest/session")
    assert response.status_code == 503
    with SessionLocal() as session:
        assert session.exec(select(WebGuestSession)).first() is None


def test_guest_payload_has_no_authenticated_capabilities(client, monkeypatch):
    data = create_guest(client, monkeypatch)
    headers = {"X-Swico-Guest-Token": data["guest_token"]}
    base = {"request_id": str(uuid4()), "message": "hello", "input_mode": "text"}
    for extra in ({"tier": "pro"}, {"provider": "openai"}, {"model": "gpt-5"},
                  {"attachment_ids": [str(uuid4())]}, {"repository_id": str(uuid4())},
                  {"voice_turn_id": str(uuid4())}, {"edit_message_id": str(uuid4())},
                  {"continue_message_id": str(uuid4())}):
        response = client.post("/api/web/guest/chat/stream", json={**base, **extra}, headers=headers)
        assert response.status_code == 422


def test_guest_chat_forces_free_without_firebase_auth(client, monkeypatch):
    data = create_guest(client, monkeypatch)
    captured = {}

    def unavailable(**kwargs):
        captured.update(kwargs)
        raise SwicoTierUnavailableError("test free unavailable")

    monkeypatch.setattr("app.web_api.router.prepare_web_turn", unavailable)
    response = client.post(
        "/api/web/guest/chat/stream",
        json={"request_id": str(uuid4()), "message": "hello", "input_mode": "text"},
        headers={"X-Swico-Guest-Token": data["guest_token"]},
    )
    assert response.status_code == 503
    assert captured["forced_swico_tier"] == "free"
    assert captured["swico_free_eligible"] is True


def test_guest_thread_ownership_is_enforced(client, monkeypatch):
    first = create_guest(client, monkeypatch)
    second = create_guest(client, monkeypatch)
    with SessionLocal() as session:
        guests = session.exec(select(WebGuestSession).order_by(WebGuestSession.created_at)).all()
        other_thread = WebChatThread(user_id=guests[1].user_id, title="Other")
        session.add(other_thread); session.commit(); session.refresh(other_thread)
        first_user_id = guests[0].user_id
        other_thread_id = other_thread.id
    with pytest.raises(LookupError):
        prepare_web_turn(
            user_id=first_user_id, message="hello", request_id=str(uuid4()),
            thread_id=other_thread_id, reply_language="en", input_mode="text",
            swico_free_eligible=True, forced_swico_tier="free",
        )
    assert second["guest_token"] != first["guest_token"]


def test_guest_cannot_cancel_another_guest_request(client, monkeypatch):
    first = create_guest(client, monkeypatch)
    second = create_guest(client, monkeypatch)
    request_id = str(uuid4())
    with SessionLocal() as session:
        guests = session.exec(select(WebGuestSession).order_by(WebGuestSession.created_at)).all()
        session.add(UsageCharge(
            request_id=request_id, user_id=guests[1].user_id,
            provider="swico_free", model="free", swico_tier="free",
            source_version="test", node_kind="chat", content_hash="x",
            source_locator="test", funding_source="free", status="free_pending",
        ))
        session.commit()
    response = client.post(
        f"/api/web/guest/chat/requests/{request_id}/cancel",
        headers={"X-Swico-Guest-Token": first["guest_token"]},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "cancelling"
    with SessionLocal() as session:
        charge = session.exec(select(UsageCharge).where(
            UsageCharge.request_id == request_id,
        )).one()
        owner = session.exec(select(WebGuestSession).where(
            WebGuestSession.token_digest == _token_digest(first["guest_token"]),
        )).one()
        assert charge.user_id != owner.user_id
        assert charge.status == "free_pending"
