from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session

import app.main as main_module
from app.database import SessionLocal
from app.models import Item, User, UserProfile


def _auth(uid: str, email: str | None = None) -> dict[str, str]:
    token = f"dev:{uid}:{email or ''}" if email else f"dev:{uid}"
    return {"Authorization": f"Bearer {token}"}


def _create_user(uid: str, email: str, name: str = "User") -> User:
    with SessionLocal() as session:
        user = User(
            firebase_uid=uid,
            email=email,
            name=name,
            timezone="Asia/Kolkata",
            assistant_name="Elli",
            reply_language="en",
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return user


def test_users_route_requires_auth(client: TestClient) -> None:
    response = client.get("/users/resolve")
    assert response.status_code == 401


def test_user_cannot_read_another_user(client: TestClient) -> None:
    user_a = _create_user("uid-a", "a@example.com", "A")
    user_b = _create_user("uid-b", "b@example.com", "B")

    response = client.get(f"/users/{user_b.id}", headers=_auth("uid-a", "a@example.com"))

    assert response.status_code == 403


def test_api_chat_ignores_spoofed_user_id(client: TestClient, monkeypatch) -> None:
    user_a = _create_user("uid-a", "a@example.com", "A")
    user_b = _create_user("uid-b", "b@example.com", "B")

    def fake_run_chat_request(session: Session, payload):
        return {"used_user_id": payload.user_id}

    monkeypatch.setattr(main_module, "_run_chat_request", fake_run_chat_request)

    response = client.post(
        "/api/chat",
        headers=_auth("uid-a", "a@example.com"),
        json={"user_id": user_b.id, "message": "hello", "reply_language": "en"},
    )

    assert response.status_code == 200
    assert response.json()["used_user_id"] == user_a.id


def test_items_reject_cross_user_access(client: TestClient) -> None:
    _create_user("uid-a", "a@example.com", "A")
    user_b = _create_user("uid-b", "b@example.com", "B")

    with SessionLocal() as session:
        item = Item(
            user_id=int(user_b.id),
            intent="note",
            category="Other",
            raw_text="private",
            source="text",
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        item_id = item.id

    response = client.get(f"/items/{item_id}", headers=_auth("uid-a", "a@example.com"))

    assert response.status_code == 404


def test_download_rejects_files_not_owned_by_current_user(client: TestClient, tmp_path: Path) -> None:
    _create_user("uid-a", "a@example.com", "A")
    user_b = _create_user("uid-b", "b@example.com", "B")

    with SessionLocal() as session:
        item = Item(
            user_id=int(user_b.id),
            intent="note",
            category="Other",
            raw_text="private",
            source="text",
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        export_dir = main_module.DOCS_BASE_DIR / "pdf" / "Other"
        export_dir.mkdir(parents=True, exist_ok=True)
        export_path = export_dir / f"item_{item.id}.pdf"
        export_path.write_bytes(b"pdf")
        token = main_module._build_download_payload(export_path, item=item)["download_id"]

    response = client.get(f"/download/{token}", headers=_auth("uid-a", "a@example.com"))

    assert response.status_code == 404


def test_conflicting_email_and_firebase_uid_returns_409(client: TestClient) -> None:
    _create_user("uid-a", "a@example.com", "A")
    _create_user("uid-b", "b@example.com", "B")

    response = client.post(
        "/users",
        headers=_auth("uid-a", "b@example.com"),
        json={
            "firebase_uid": "uid-a",
            "email": "b@example.com",
            "name": "Conflict",
            "place": "Chennai",
            "timezone": "Asia/Kolkata",
            "assistant_name": "Elli",
            "reply_language": "en",
        },
    )

    assert response.status_code == 409


def test_list_valued_personality_answers_are_accepted(client: TestClient) -> None:
    user = _create_user("uid-a", "a@example.com", "A")

    response = client.post(
        f"/users/{user.id}/personality",
        headers=_auth("uid-a", "a@example.com"),
        json={"answers": {"interests": ["music", "reading"]}},
    )

    assert response.status_code == 200
    with SessionLocal() as session:
        profile = session.query(UserProfile).filter(UserProfile.user_id == user.id).first()
        assert json.loads(profile.answers_json)["interests"] == ["music", "reading"]
