from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient
from sqlmodel import select

from app.database import SessionLocal
from app.email_otp import (
    EmailOtpError,
    create_otp_code,
    generate_otp,
    hash_otp,
    is_valid_email,
    normalize_email,
    seconds_until_resend_allowed,
    verify_and_consume_otp,
    verify_otp_hash,
)
from app.models import EmailOtpCode, User, UserProfile
from app.time_utils import utc_now


class FakeEmailSender:
    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []

    def send(self, *, to_email: str, subject: str, text_body: str) -> None:
        self.sent.append(
            {"to_email": to_email, "subject": subject, "text_body": text_body}
        )


def _patch_email_sender(monkeypatch) -> FakeEmailSender:
    sender = FakeEmailSender()
    monkeypatch.setattr("app.main.get_email_sender", lambda: sender)
    return sender


def _patch_firebase_exists(monkeypatch, exists: bool = False) -> None:
    monkeypatch.setattr("app.main.firebase_user_exists_by_email", lambda email: exists)


def test_email_otp_pure_functions_hash_without_raw_code(monkeypatch) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    code = generate_otp()

    assert code.isdigit()
    assert len(code) == 6
    assert normalize_email("  USER@Example.COM ") == "user@example.com"
    assert is_valid_email("user@example.com")
    assert not is_valid_email("not-an-email")

    digest = hash_otp("USER@example.com", "signup", code)
    assert digest != code
    assert code not in digest
    assert verify_otp_hash(
        email="user@example.com",
        purpose="signup",
        otp=code,
        expected_hash=digest,
    )
    assert not verify_otp_hash(
        email="user@example.com",
        purpose="signup",
        otp="000000" if code != "000000" else "111111",
        expected_hash=digest,
    )


def test_create_otp_stores_hash_not_raw_code(monkeypatch) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")

    with SessionLocal() as session:
        stored = create_otp_code(session, email="User@Example.com", purpose="signup")
        record = session.get(EmailOtpCode, stored.record.id)

    assert record is not None
    assert record.email == "user@example.com"
    assert record.purpose == "signup"
    assert record.otp_hash != stored.code
    assert stored.code not in record.otp_hash


def test_verify_rejects_wrong_expired_and_consumed_codes(monkeypatch) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    now = utc_now()

    with SessionLocal() as session:
        active = create_otp_code(
            session,
            email="user@example.com",
            purpose="signup",
            now=now,
        )

        try:
            verify_and_consume_otp(
                session,
                email="user@example.com",
                purpose="signup",
                otp="000000" if active.code != "000000" else "111111",
                now=now,
            )
        except EmailOtpError as exc:
            assert exc.code == "otp_incorrect"
        else:  # pragma: no cover
            raise AssertionError("wrong OTP should fail")

        consumed = verify_and_consume_otp(
            session,
            email="user@example.com",
            purpose="signup",
            otp=active.code,
            now=now,
        )
        assert consumed.consumed_at is not None

        try:
            verify_and_consume_otp(
                session,
                email="user@example.com",
                purpose="signup",
                otp=active.code,
                now=now,
            )
        except EmailOtpError as exc:
            assert exc.code == "otp_invalid_or_expired"
        else:  # pragma: no cover
            raise AssertionError("consumed OTP should fail")

        expired = create_otp_code(
            session,
            email="expired@example.com",
            purpose="signup",
            now=now - timedelta(minutes=20),
        )
        try:
            verify_and_consume_otp(
                session,
                email="expired@example.com",
                purpose="signup",
                otp=expired.code,
                now=now,
            )
        except EmailOtpError as exc:
            assert exc.code == "otp_invalid_or_expired"
        else:  # pragma: no cover
            raise AssertionError("expired OTP should fail")


def test_cooldown_and_max_attempt_behavior(monkeypatch) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    now = utc_now()

    assert seconds_until_resend_allowed(
        now,
        now=now + timedelta(seconds=10),
        cooldown_seconds=60,
    ) == 50

    with SessionLocal() as session:
        stored = create_otp_code(
            session,
            email="attempts@example.com",
            purpose="password_reset",
            now=now,
        )

        for attempt in range(5):
            try:
                verify_and_consume_otp(
                    session,
                    email="attempts@example.com",
                    purpose="password_reset",
                    otp="000000" if stored.code != "000000" else "111111",
                    now=now + timedelta(seconds=attempt),
                    max_attempts=5,
                )
            except EmailOtpError as exc:
                expected = "otp_too_many_attempts" if attempt == 4 else "otp_incorrect"
                assert exc.code == expected
            else:  # pragma: no cover
                raise AssertionError("wrong OTP should fail")

        record = session.get(EmailOtpCode, stored.record.id)
        assert record is not None
        assert record.attempts == 5
        assert record.consumed_at is not None


def test_signup_request_sends_email_with_fake_smtp(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, False)
    sender = _patch_email_sender(monkeypatch)

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "New@Example.com", "name": "New User"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["cooldown_seconds"] == 60
    assert payload["otp"].isdigit()
    assert sender.sent[0]["to_email"] == "new@example.com"
    assert payload["otp"] in sender.sent[0]["text_body"]

    with SessionLocal() as session:
        record = session.exec(select(EmailOtpCode)).one()
    assert payload["otp"] not in record.otp_hash


def test_signup_request_duplicate_email_returns_409(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    _patch_firebase_exists(monkeypatch, False)

    with SessionLocal() as session:
        session.add(
            User(
                firebase_uid="uid-existing",
                email="exists@example.com",
                name="Existing",
                reply_language="en",
            )
        )
        session.commit()

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "exists@example.com", "name": "Existing"},
    )

    assert response.status_code == 409
    assert "already registered" in response.json()["detail"]


def test_signup_complete_creates_firebase_user_and_backend_profile(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, False)
    _patch_email_sender(monkeypatch)
    created: list[dict[str, str]] = []

    def fake_create(**kwargs):
        created.append(kwargs)
        return {"uid": "firebase-uid-1", "email": kwargs["email"], "email_verified": True}

    monkeypatch.setattr("app.main.create_firebase_email_password_user", fake_create)

    request_response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "signup@example.com", "name": "Signup User"},
    )
    otp = request_response.json()["otp"]

    complete_response = client.post(
        "/auth/email-otp/signup/complete",
        json={
            "name": "Signup User",
            "email": "signup@example.com",
            "password": "secret123",
            "otp": otp,
        },
    )

    assert complete_response.status_code == 200
    payload = complete_response.json()
    assert payload["ok"] is True
    assert payload["user"]["firebase_uid"] == "firebase-uid-1"
    assert payload["user"]["email"] == "signup@example.com"
    assert payload["user"]["assistant_name"] == "Elli"
    assert created[0]["email_verified"] is True

    with SessionLocal() as session:
        user = session.exec(select(User).where(User.email == "signup@example.com")).one()
        profile = session.exec(select(UserProfile).where(UserProfile.user_id == user.id)).one()
    assert user.firebase_uid == "firebase-uid-1"
    assert profile.user_id == user.id


def test_signup_complete_rejects_wrong_otp(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, False)
    _patch_email_sender(monkeypatch)

    request_response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "wrong@example.com", "name": "Wrong Otp"},
    )
    otp = request_response.json()["otp"]
    wrong = "000000" if otp != "000000" else "111111"

    response = client.post(
        "/auth/email-otp/signup/complete",
        json={
            "name": "Wrong Otp",
            "email": "wrong@example.com",
            "password": "secret123",
            "otp": wrong,
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "otp_incorrect"


def test_password_reset_request_is_generic_for_unknown_email(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    _patch_firebase_exists(monkeypatch, False)
    sender = _patch_email_sender(monkeypatch)

    response = client.post(
        "/auth/email-otp/password-reset/request",
        json={"email": "unknown@example.com"},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "If an account exists for this email, we sent a reset code."
    assert sender.sent == []


def test_password_reset_confirm_updates_firebase_password(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, True)
    _patch_email_sender(monkeypatch)
    updates: list[dict[str, str]] = []
    revocations: list[str] = []

    monkeypatch.setattr(
        "app.main.update_firebase_user_password_by_email",
        lambda **kwargs: updates.append(kwargs) or {"uid": "uid-reset"},
    )
    monkeypatch.setattr(
        "app.main.revoke_firebase_refresh_tokens_by_email",
        lambda email: revocations.append(email) or True,
    )

    request_response = client.post(
        "/auth/email-otp/password-reset/request",
        json={"email": "reset@example.com"},
    )
    otp = request_response.json()["otp"]

    response = client.post(
        "/auth/email-otp/password-reset/confirm",
        json={
            "email": "reset@example.com",
            "otp": otp,
            "new_password": "newsecret",
        },
    )

    assert response.status_code == 200
    assert response.json()["message"] == "Password updated. Please log in with your new password."
    assert updates == [{"email": "reset@example.com", "new_password": "newsecret"}]
    assert revocations == ["reset@example.com"]


def test_production_never_returns_dev_otp(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, False)
    _patch_email_sender(monkeypatch)

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "prod@example.com", "name": "Prod User"},
    )

    assert response.status_code == 200
    assert "otp" not in response.json()


def test_missing_smtp_config_returns_safe_error(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.delenv("EMAIL_USER", raising=False)
    monkeypatch.delenv("EMAIL_PASS", raising=False)
    _patch_firebase_exists(monkeypatch, False)

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "smtp@example.com", "name": "Smtp User"},
    )

    assert response.status_code == 503
    assert "EMAIL_PASS" in response.json()["detail"]
    assert "otp-test-secret" not in response.text


def test_existing_protected_routes_still_require_auth(client: TestClient) -> None:
    response = client.get("/users/me")
    assert response.status_code == 401
