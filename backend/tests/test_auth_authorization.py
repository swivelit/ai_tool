from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

from fastapi.testclient import TestClient
import pytest
from sqlmodel import Session

import app.main as main_module
from app import auth as auth_module
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


def test_invalid_auth_returns_401(client: TestClient) -> None:
    response = client.get("/users/resolve", headers={"Authorization": "Bearer dev:"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid auth token"


def test_users_resolve_returns_not_found_for_valid_auth_without_user(client: TestClient) -> None:
    response = client.get("/users/resolve", headers=_auth("uid-new", "new@example.com"))

    assert response.status_code == 200
    assert response.json() == {"found": False}


def test_users_create_or_update_for_valid_auth(client: TestClient) -> None:
    create_response = client.post(
        "/users",
        headers=_auth("uid-new", "new@example.com"),
        json={
            "firebase_uid": "client-spoof-ignored",
            "email": "ignored@example.com",
            "name": "New User",
            "place": "Chennai",
            "timezone": "Asia/Kolkata",
            "assistant_name": "Elli",
            "reply_language": "en",
        },
    )

    assert create_response.status_code == 200
    created = create_response.json()
    assert created["firebase_uid"] == "uid-new"
    assert created["email"] == "new@example.com"
    assert created["name"] == "New User"
    assert created["id"]

    update_response = client.post(
        "/users",
        headers=_auth("uid-new", "new@example.com"),
        json={
            "firebase_uid": "uid-new",
            "email": "new@example.com",
            "name": "Updated User",
            "place": "Madurai",
            "timezone": "Asia/Kolkata",
            "assistant_name": "Elli",
            "reply_language": "ta",
        },
    )

    assert update_response.status_code == 200
    updated = update_response.json()
    assert updated["id"] == created["id"]
    assert updated["name"] == "Updated User"
    assert updated["reply_language"] == "ta"


def test_public_health_does_not_leak_auth_configuration(client: TestClient) -> None:
    for path in ("/health", "/api/health"):
        response = client.get(path)
        payload = response.json()

        assert set(payload) == {"status", "app"}
        assert payload["app"] == "J AI"
        assert "auth" not in payload
        assert "services" not in payload
        assert "errors" not in payload
        assert "dev_tokens_enabled" not in json.dumps(payload)
        assert "credentials_json_set" not in json.dumps(payload)
        assert "firebase" not in json.dumps(payload).lower()


def test_debug_health_reports_firebase_auth_configuration_in_development(
    client: TestClient,
) -> None:
    response = client.get("/api/debug/health")

    firebase = response.json()["auth"]["firebase"]
    assert firebase["token_verification_configured"] is True
    assert firebase["dev_tokens_enabled"] is True


def test_debug_health_is_not_public_in_production(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(main_module, "APP_ENV", "production")

    response = client.get("/api/debug/health")

    assert response.status_code == 404


def test_production_rejects_dev_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("AUTH_ALLOW_DEV_TOKENS", "true")

    with pytest.raises(
        auth_module.AuthConfigurationError,
        match="AUTH_ALLOW_DEV_TOKENS",
    ):
        auth_module.validate_auth_configuration()


def test_test_environment_can_allow_dev_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("AUTH_ALLOW_DEV_TOKENS", "true")

    auth_module.validate_auth_configuration()


def test_backend_startup_fails_loudly_with_prod_dev_tokens(tmp_path: Path) -> None:
    backend_root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update(
        {
            "APP_ENV": "production",
            "AUTH_ALLOW_DEV_TOKENS": "true",
            "DOWNLOAD_TOKEN_SECRET": "test-secret",
            "DATABASE_URL": f"sqlite:///{(tmp_path / 'startup.sqlite3').as_posix()}",
            "AUTO_CREATE_TABLES": "false",
            "JOB_WORKER_ENABLED": "false",
            "OPENAI_API_KEY": "",
            "SARVAM_API_KEY": "",
            "SENTRY_DSN": "",
        }
    )

    result = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        cwd=backend_root,
        env=env,
        capture_output=True,
        text=True,
        timeout=20,
    )

    assert result.returncode != 0
    assert "AUTH_ALLOW_DEV_TOKENS" in (result.stderr + result.stdout)


def test_missing_firebase_admin_config_returns_clear_503(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setenv("AUTH_ALLOW_DEV_TOKENS", "false")
    for name in (
        "FIREBASE_CREDENTIALS_JSON",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GCP_PROJECT",
        "GCLOUD_PROJECT",
        "FIREBASE_CONFIG",
    ):
        monkeypatch.delenv(name, raising=False)

    auth_module._firebase_auth_module.cache_clear()
    try:
        import firebase_admin

        for app in list(getattr(firebase_admin, "_apps", {}).values()):
            firebase_admin.delete_app(app)
    except Exception:
        pass

    response = client.get("/users/resolve", headers={"Authorization": "Bearer real-token"})

    assert response.status_code == 503
    assert "Firebase Admin credentials are not configured" in response.json()["detail"]


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
