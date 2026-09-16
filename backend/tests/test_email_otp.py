from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

import app.main as main_module
from app.auth import FirebaseIdentityInspection
from app.database import SessionLocal
from app.email_otp import (
    EmailOtpError,
    OtpSettings,
    create_otp_code,
    expiry_from,
    generate_otp,
    hash_otp,
    is_valid_email,
    normalize_email,
    otp_http_exception,
    seconds_until_resend_allowed,
    verify_and_consume_otp,
    verify_otp_hash,
)
from app.email_service import EmailDeliverySendError, email_delivery_runtime_status
from app.cli_api.security import digest
from app.models import CliSession, EmailOtpCode, User, UserProfile
from app.time_utils import utc_now


class FakeEmailSender:
    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []

    def send(self, *, to_email: str, subject: str, text_body: str) -> None:
        self.sent.append(
            {"to_email": to_email, "subject": subject, "text_body": text_body}
        )


class FailingEmailSender(FakeEmailSender):
    def __init__(self) -> None:
        super().__init__()
        self.last_code = ""

    def send(self, *, to_email: str, subject: str, text_body: str) -> None:
        self.sent.append(
            {"to_email": to_email, "subject": subject, "text_body": text_body}
        )
        match = re.search(r"\b(\d{6})\b", text_body)
        self.last_code = match.group(1) if match else ""
        raise EmailDeliverySendError(
            stage="login",
            exception_class="SMTPAuthenticationError",
            host="smtp.gmail.com",
            port=587,
            use_tls=True,
        )


def _patch_email_sender(monkeypatch) -> FakeEmailSender:
    sender = FakeEmailSender()
    monkeypatch.setattr("app.main.get_email_sender", lambda: sender)
    return sender


def _patch_failing_email_sender(monkeypatch) -> FailingEmailSender:
    sender = FailingEmailSender()
    monkeypatch.setattr("app.main.get_email_sender", lambda: sender)
    return sender


def _patch_firebase_exists(monkeypatch, exists: bool = False) -> None:
    monkeypatch.setattr("app.main.firebase_user_exists_by_email", lambda email: exists)


def _set_production_email_env(monkeypatch) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("EMAIL_USER", "sender@example.com")
    monkeypatch.setenv("EMAIL_PASS", "smtp-test-password")
    monkeypatch.setenv("EMAIL_FROM", "sender@example.com")
    monkeypatch.setenv("SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USE_TLS", "true")
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")


def _assert_safe_email_delivery_detail(response, code: str) -> None:
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail == {
        "code": code,
        "message": "Email delivery is temporarily unavailable. Please try again later.",
    }


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


@pytest.mark.parametrize(
    ("code", "status_code"),
    [
        ("otp_cooldown", 429),
        ("invalid_email", 400),
        ("otp_invalid_or_expired", 400),
        ("otp_incorrect", 400),
        ("otp_too_many_attempts", 429),
    ],
)
def test_known_otp_errors_map_to_structured_http_json(
    code: str,
    status_code: int,
) -> None:
    error = EmailOtpError("Safe OTP message.", code=code, status_code=status_code)

    mapped = otp_http_exception(error)

    assert mapped.status_code == status_code
    assert mapped.detail == {"code": code, "message": "Safe OTP message."}


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


@pytest.mark.parametrize(
    ("current_is_aware", "last_sent_is_aware"),
    [(True, True), (True, False), (False, True), (False, False)],
)
def test_cooldown_accepts_every_naive_and_aware_combination(
    current_is_aware: bool,
    last_sent_is_aware: bool,
) -> None:
    base = datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)
    current = base + timedelta(seconds=10)
    last_sent = base
    if not current_is_aware:
        current = current.replace(tzinfo=None)
    if not last_sent_is_aware:
        last_sent = last_sent.replace(tzinfo=None)

    assert seconds_until_resend_allowed(
        last_sent,
        now=current,
        cooldown_seconds=60,
    ) == 50


def test_cooldown_boundaries_rounding_clock_skew_and_missing_timestamp() -> None:
    now = datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)

    assert seconds_until_resend_allowed(None, now=now, cooldown_seconds=60) == 0
    assert seconds_until_resend_allowed(
        now - timedelta(seconds=60), now=now, cooldown_seconds=60
    ) == 0
    assert seconds_until_resend_allowed(
        now - timedelta(seconds=10, milliseconds=200),
        now=now,
        cooldown_seconds=60,
    ) == 50
    assert seconds_until_resend_allowed(
        now + timedelta(seconds=3), now=now, cooldown_seconds=60
    ) == 60


def test_expiry_from_normalizes_naive_input_to_aware_utc() -> None:
    naive = datetime(2026, 7, 16, 9, 30)

    expires_at = expiry_from(naive, ttl_seconds=90)

    assert expires_at == datetime(2026, 7, 16, 9, 31, 30, tzinfo=timezone.utc)


def test_otp_model_declares_timezone_aware_timestamp_columns() -> None:
    for name in ("created_at", "expires_at", "consumed_at", "last_sent_at"):
        assert EmailOtpCode.__table__.c[name].type.timezone is True


def test_database_round_trip_enforces_cooldown_then_allows_and_consumes(
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    now = datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)
    settings = OtpSettings(
        ttl_seconds=600,
        cooldown_seconds=60,
        max_attempts=5,
        dev_return_code=False,
    )

    with SessionLocal() as session:
        first = create_otp_code(
            session,
            email="roundtrip@example.com",
            purpose="signup",
            now=now,
            settings=settings,
        )
        first_id = first.record.id

    with SessionLocal() as session:
        reloaded = session.get(EmailOtpCode, first_id)
        assert reloaded is not None
        # This reproduces the PostgreSQL production value shape explicitly,
        # even on database drivers that preserve timezone information.
        reloaded.last_sent_at = reloaded.last_sent_at.replace(tzinfo=None)
        session.add(reloaded)
        session.commit()

    with SessionLocal() as session:
        with pytest.raises(EmailOtpError) as cooldown:
            create_otp_code(
                session,
                email="roundtrip@example.com",
                purpose="signup",
                now=now + timedelta(seconds=10),
                settings=settings,
            )
        assert cooldown.value.code == "otp_cooldown"
        assert cooldown.value.status_code == 429

    with SessionLocal() as session:
        second = create_otp_code(
            session,
            email="roundtrip@example.com",
            purpose="signup",
            now=now + timedelta(seconds=61),
            settings=settings,
        )
        second_id = second.record.id
        second_code = second.code

    with SessionLocal() as session:
        consumed = verify_and_consume_otp(
            session,
            email="roundtrip@example.com",
            purpose="signup",
            otp=second_code,
            now=(now + timedelta(seconds=62)).replace(tzinfo=None),
        )
        assert consumed.id == second_id
        assert consumed.consumed_at is not None

    with SessionLocal() as session:
        reloaded_consumed = session.get(EmailOtpCode, second_id)
        assert reloaded_consumed is not None
        assert reloaded_consumed.consumed_at is not None


def test_database_round_trip_expiry_check_handles_naive_timestamp(
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    now = datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)
    settings = OtpSettings(
        ttl_seconds=30,
        cooldown_seconds=10,
        max_attempts=5,
        dev_return_code=False,
    )

    with SessionLocal() as session:
        stored = create_otp_code(
            session,
            email="expired-roundtrip@example.com",
            purpose="password_reset",
            now=now,
            settings=settings,
        )
        code = stored.code

    with SessionLocal() as session:
        with pytest.raises(EmailOtpError) as expired:
            verify_and_consume_otp(
                session,
                email="expired-roundtrip@example.com",
                purpose="password_reset",
                otp=code,
                now=now + timedelta(seconds=31),
            )
        assert expired.value.code == "otp_invalid_or_expired"


def test_database_round_trip_persists_attempt_tracking(monkeypatch) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    now = datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)

    with SessionLocal() as session:
        stored = create_otp_code(
            session,
            email="attempt-roundtrip@example.com",
            purpose="password_reset",
            now=now,
        )
        record_id = stored.record.id
        code = stored.code

    wrong_code = "000000" if code != "000000" else "111111"
    with SessionLocal() as session:
        with pytest.raises(EmailOtpError) as incorrect:
            verify_and_consume_otp(
                session,
                email="attempt-roundtrip@example.com",
                purpose="password_reset",
                otp=wrong_code,
                now=(now + timedelta(seconds=1)).replace(tzinfo=None),
            )
        assert incorrect.value.code == "otp_incorrect"

    with SessionLocal() as session:
        reloaded = session.get(EmailOtpCode, record_id)
        assert reloaded is not None
        assert reloaded.attempts == 1
        consumed = verify_and_consume_otp(
            session,
            email="attempt-roundtrip@example.com",
            purpose="password_reset",
            otp=code,
            now=now + timedelta(seconds=2),
        )
        assert consumed.consumed_at is not None


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


def test_signup_request_with_naive_existing_timestamp_returns_cooldown_not_500(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    _patch_firebase_exists(monkeypatch, False)
    sender = _patch_email_sender(monkeypatch)
    now = utc_now().replace(microsecond=0)
    naive_now = now.replace(tzinfo=None)

    with SessionLocal() as session:
        session.add(
            EmailOtpCode(
                email="mixed-signup@example.com",
                purpose="signup",
                otp_hash=hash_otp("mixed-signup@example.com", "signup", "123456"),
                created_at=naive_now,
                expires_at=naive_now + timedelta(minutes=10),
                last_sent_at=naive_now,
            )
        )
        session.commit()

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "mixed-signup@example.com", "name": "Mixed Signup"},
    )

    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "otp_cooldown"
    assert "wait" in response.json()["detail"]["message"].lower()
    assert sender.sent == []


def test_expired_naive_signup_record_allows_exactly_one_new_email(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    _patch_firebase_exists(monkeypatch, False)
    sender = _patch_email_sender(monkeypatch)
    now = utc_now().replace(microsecond=0)
    old = (now - timedelta(minutes=20)).replace(tzinfo=None)

    with SessionLocal() as session:
        session.add(
            EmailOtpCode(
                email="expired-route@example.com",
                purpose="signup",
                otp_hash=hash_otp("expired-route@example.com", "signup", "123456"),
                created_at=old,
                expires_at=old + timedelta(minutes=10),
                last_sent_at=old,
            )
        )
        session.commit()

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "expired-route@example.com", "name": "Expired Route"},
    )

    assert response.status_code == 200
    assert len(sender.sent) == 1


def test_password_reset_request_handles_naive_existing_timestamp(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    _patch_firebase_exists(monkeypatch, True)
    sender = _patch_email_sender(monkeypatch)
    now = utc_now().replace(microsecond=0).replace(tzinfo=None)

    with SessionLocal() as session:
        session.add(
            EmailOtpCode(
                email="mixed-reset@example.com",
                purpose="password_reset",
                otp_hash=hash_otp(
                    "mixed-reset@example.com", "password_reset", "123456"
                ),
                created_at=now,
                expires_at=now + timedelta(minutes=10),
                last_sent_at=now,
            )
        )
        session.commit()

    response = client.post(
        "/auth/email-otp/password-reset/request",
        json={"email": "mixed-reset@example.com"},
    )

    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "otp_cooldown"
    assert sender.sent == []


def test_successful_otp_request_logs_neither_email_nor_code(
    client: TestClient,
    monkeypatch,
    caplog,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, False)
    sender = _patch_email_sender(monkeypatch)
    caplog.set_level(logging.INFO)

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "log-safe@example.com", "name": "Log Safe"},
        headers={"x-request-id": "req-log-safe"},
    )

    assert response.status_code == 200
    assert len(sender.sent) == 1
    assert "log-safe@example.com" not in caplog.text
    assert response.json()["otp"] not in caplog.text


def test_unexpected_otp_error_returns_safe_json_500_with_request_id(
    client: TestClient,
    monkeypatch,
    caplog,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    _patch_firebase_exists(monkeypatch, False)
    _patch_email_sender(monkeypatch)
    caplog.set_level(logging.ERROR)

    def fail_create(*args, **kwargs):
        raise TypeError("database detail that must stay server-side")

    monkeypatch.setattr("app.main.create_otp_code", fail_create)
    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "safe-500@example.com", "name": "Safe Error"},
        headers={"x-request-id": "req-safe-500"},
    )

    assert response.status_code == 500
    assert response.headers["x-request-id"] == "req-safe-500"
    assert response.json()["detail"] == {
        "code": "otp_request_failed",
        "message": "We could not send the code. Please try again.",
    }
    assert "database detail" not in response.text
    assert "safe-500@example.com" not in caplog.text
    failure_record = next(
        record
        for record in caplog.records
        if getattr(record, "event", "") == "otp_request_failed"
    )
    assert getattr(failure_record, "request_id") == "req-safe-500"


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

    monkeypatch.setattr("app.main.inspect_firebase_identity", lambda **kwargs: FirebaseIdentityInspection(
        email_user=SimpleNamespace(uid="uid-reset", email="reset@example.com"),
        stored_uid_user=None,
    ))
    monkeypatch.setattr(
        "app.main.update_firebase_user_password_by_uid",
        lambda **kwargs: updates.append(kwargs) or {"uid": "uid-reset"},
    )
    monkeypatch.setattr(
        "app.main.revoke_firebase_refresh_tokens_by_uid",
        lambda firebase_uid: revocations.append(firebase_uid),
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
    assert updates == [{"firebase_uid": "uid-reset", "new_password": "newsecret"}]
    assert revocations == ["uid-reset"]
    with SessionLocal() as session:
        record = session.exec(select(EmailOtpCode).where(EmailOtpCode.email == "reset@example.com")).one()
        assert record.consumed_at is not None
    reused = client.post(
        "/auth/email-otp/password-reset/confirm",
        json={"email": "reset@example.com", "otp": otp, "new_password": "anothersecret"},
    )
    assert reused.status_code == 400
    assert reused.json()["detail"]["code"] == "otp_invalid_or_expired"


def _fake_firebase_inspection(email_user=None, stored_uid_user=None):
    return FirebaseIdentityInspection(
        email_user=email_user,
        stored_uid_user=stored_uid_user,
    )


def test_password_reset_repairs_backend_only_orphan_without_new_backend_user(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, False)
    _patch_email_sender(monkeypatch)
    with SessionLocal() as session:
        user = User(
            firebase_uid="orphan-stored-uid",
            email="orphan@example.com",
            name="Orphan User",
            reply_language="en",
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        user_id = int(user.id)
        session.add(CliSession(
            user_id=user_id,
            client_id="swico-cli",
            access_token_digest=digest("a" * 64),
            access_expires_at=utc_now() + timedelta(minutes=5),
            refresh_token_digest=digest("b" * 64),
            refresh_expires_at=utc_now() + timedelta(days=1),
            max_expires_at=utc_now() + timedelta(days=1),
            selected_tier="lite",
        ))
        session.commit()

    created = []
    revoked = []
    monkeypatch.setattr("app.main.inspect_firebase_identity", lambda **kwargs: _fake_firebase_inspection())
    monkeypatch.setattr(
        "app.main.create_firebase_email_password_user",
        lambda **kwargs: created.append(kwargs) or {
            "uid": "orphan-stored-uid",
            "email": "orphan@example.com",
            "email_verified": True,
        },
    )
    monkeypatch.setattr(
        "app.main.revoke_firebase_refresh_tokens_by_uid",
        lambda firebase_uid: revoked.append(firebase_uid),
    )

    request = client.post(
        "/auth/email-otp/password-reset/request",
        json={"email": "orphan@example.com"},
    )
    response = client.post(
        "/auth/email-otp/password-reset/confirm",
        json={"email": "orphan@example.com", "otp": request.json()["otp"], "new_password": "newsecret"},
    )

    assert response.status_code == 200
    assert created[0]["firebase_uid"] == "orphan-stored-uid"
    assert created[0]["email_verified"] is True
    assert revoked == ["orphan-stored-uid"]
    with SessionLocal() as session:
        users = session.exec(select(User).where(User.email == "orphan@example.com")).all()
        assert len(users) == 1 and int(users[0].id) == user_id
        otp = session.exec(select(EmailOtpCode).where(EmailOtpCode.email == "orphan@example.com")).one()
        assert otp.consumed_at is not None
        cli = session.exec(select(CliSession).where(CliSession.user_id == user_id)).one()
        assert cli.revoked_at is not None and cli.revoke_reason == "password_reset"


def test_password_reset_transient_firebase_failure_leaves_correct_otp_usable(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, True)
    _patch_email_sender(monkeypatch)
    monkeypatch.setattr(
        "app.main.inspect_firebase_identity",
        lambda **kwargs: _fake_firebase_inspection(
            SimpleNamespace(uid="recoverable-uid", email="retry@example.com")
        ),
    )
    calls = []

    def flaky_update(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise RuntimeError("temporary Firebase outage")
        return {"uid": "recoverable-uid", "email": "retry@example.com"}

    monkeypatch.setattr("app.main.update_firebase_user_password_by_uid", flaky_update)
    monkeypatch.setattr("app.main.revoke_firebase_refresh_tokens_by_uid", lambda firebase_uid: None)
    request = client.post(
        "/auth/email-otp/password-reset/request",
        json={"email": "retry@example.com"},
    )
    body = {"email": "retry@example.com", "otp": request.json()["otp"], "new_password": "newsecret"}

    first = client.post("/auth/email-otp/password-reset/confirm", json=body)
    assert first.status_code == 503
    assert "Firebase" not in first.text
    with SessionLocal() as session:
        record = session.exec(select(EmailOtpCode).where(EmailOtpCode.email == "retry@example.com")).one()
        assert record.consumed_at is None

    second = client.post("/auth/email-otp/password-reset/confirm", json=body)
    assert second.status_code == 200
    assert len(calls) == 2


def test_password_reset_reconciles_replacement_uid_and_preserves_backend_id(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, True)
    _patch_email_sender(monkeypatch)
    with SessionLocal() as session:
        user = User(firebase_uid="stale-uid", email="replacement@example.com", name="Replacement", reply_language="en")
        session.add(user)
        session.commit()
        session.refresh(user)
        user_id = int(user.id)
    monkeypatch.setattr(
        "app.main.inspect_firebase_identity",
        lambda **kwargs: _fake_firebase_inspection(
            SimpleNamespace(uid="replacement-uid", email="replacement@example.com")
        ),
    )
    monkeypatch.setattr("app.main.update_firebase_user_password_by_uid", lambda **kwargs: {"uid": "replacement-uid"})
    monkeypatch.setattr("app.main.revoke_firebase_refresh_tokens_by_uid", lambda firebase_uid: None)
    request = client.post("/auth/email-otp/password-reset/request", json={"email": "replacement@example.com"})
    response = client.post(
        "/auth/email-otp/password-reset/confirm",
        json={"email": "replacement@example.com", "otp": request.json()["otp"], "new_password": "newsecret"},
    )
    assert response.status_code == 200
    with SessionLocal() as session:
        user = session.get(User, user_id)
        assert user is not None and int(user.id) == user_id and user.firebase_uid == "replacement-uid"


@pytest.mark.parametrize("conflict_kind", ["different_email_stored_uid", "uid_owned_by_other_backend"])
def test_password_reset_identity_conflicts_fail_closed(
    client: TestClient,
    monkeypatch,
    conflict_kind: str,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, True)
    _patch_email_sender(monkeypatch)
    with SessionLocal() as session:
        user = User(firebase_uid="stored-conflict-uid", email="conflict@example.com", name="Conflict", reply_language="en")
        session.add(user)
        session.commit()
        if conflict_kind == "uid_owned_by_other_backend":
            session.add(User(firebase_uid="replacement-uid", email="other@example.com", name="Other", reply_language="en"))
            session.commit()
    if conflict_kind == "different_email_stored_uid":
        inspection = _fake_firebase_inspection(
            stored_uid_user=SimpleNamespace(uid="stored-conflict-uid", email="other@example.com")
        )
    else:
        inspection = _fake_firebase_inspection(
            email_user=SimpleNamespace(uid="replacement-uid", email="conflict@example.com")
        )
    monkeypatch.setattr("app.main.inspect_firebase_identity", lambda **kwargs: inspection)
    monkeypatch.setattr("app.main.update_firebase_user_password_by_uid", lambda **kwargs: pytest.fail("conflict must not update Firebase"))
    request = client.post("/auth/email-otp/password-reset/request", json={"email": "conflict@example.com"})
    response = client.post(
        "/auth/email-otp/password-reset/confirm",
        json={"email": "conflict@example.com", "otp": request.json()["otp"], "new_password": "newsecret"},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "We couldn't restore this account automatically. Please contact support."


def test_password_reset_firebase_configuration_failure_is_safe_503(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("EMAIL_OTP_SECRET", "otp-test-secret")
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, False)
    _patch_email_sender(monkeypatch)
    with SessionLocal() as session:
        session.add(User(firebase_uid="config-uid", email="config@example.com", name="Config", reply_language="en"))
        session.commit()
    monkeypatch.setattr(
        "app.main.inspect_firebase_identity",
        lambda **kwargs: (_ for _ in ()).throw(main_module.AuthConfigurationError("private config detail")),
    )
    request = client.post("/auth/email-otp/password-reset/request", json={"email": "config@example.com"})
    response = client.post(
        "/auth/email-otp/password-reset/confirm",
        json={"email": "config@example.com", "otp": request.json()["otp"], "new_password": "newsecret"},
    )
    assert response.status_code == 503
    assert "private config detail" not in response.text
    assert "Firebase" not in response.text


def test_production_never_returns_dev_otp(client: TestClient, monkeypatch) -> None:
    _set_production_email_env(monkeypatch)
    monkeypatch.setenv("EMAIL_OTP_DEV_RETURN_CODE", "true")
    _patch_firebase_exists(monkeypatch, False)
    _patch_email_sender(monkeypatch)

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "prod@example.com", "name": "Prod User"},
    )

    assert response.status_code == 200
    assert "otp" not in response.json()


def test_missing_email_user_in_production_returns_safe_503(
    client: TestClient,
    monkeypatch,
) -> None:
    _set_production_email_env(monkeypatch)
    monkeypatch.delenv("EMAIL_USER", raising=False)
    _patch_firebase_exists(monkeypatch, False)

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "smtp-user@example.com", "name": "Smtp User"},
    )

    _assert_safe_email_delivery_detail(response, "email_delivery_unconfigured")
    assert "smtp-test-password" not in response.text
    assert "otp-test-secret" not in response.text


def test_missing_email_pass_in_production_returns_safe_503(
    client: TestClient,
    monkeypatch,
) -> None:
    _set_production_email_env(monkeypatch)
    monkeypatch.delenv("EMAIL_PASS", raising=False)
    _patch_firebase_exists(monkeypatch, False)

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "smtp-pass@example.com", "name": "Smtp Pass"},
    )

    _assert_safe_email_delivery_detail(response, "email_delivery_unconfigured")
    assert "sender@example.com" not in response.text
    assert "otp-test-secret" not in response.text


def test_missing_email_otp_secret_is_diagnosed_and_blocks_otp(
    client: TestClient,
    monkeypatch,
) -> None:
    _set_production_email_env(monkeypatch)
    monkeypatch.delenv("EMAIL_OTP_SECRET", raising=False)
    _patch_firebase_exists(monkeypatch, False)

    status = email_delivery_runtime_status()
    assert status["email_otp_secret_set"] is False
    assert "EMAIL_OTP_SECRET" in status["missing"]
    assert status["configured"] is False

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "otp-secret@example.com", "name": "Otp Secret"},
    )

    _assert_safe_email_delivery_detail(response, "email_delivery_unconfigured")
    assert "otp-test-secret" not in response.text


def test_email_diagnostics_do_not_expose_secret_values(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DEBUG_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("ADMIN_EMAILS", "")
    monkeypatch.setenv("EMAIL_USER", "harisender@example.com")
    monkeypatch.setenv("EMAIL_PASS", "super-secret-email-pass")
    monkeypatch.setenv("EMAIL_FROM", "harisender@example.com")
    monkeypatch.setenv("EMAIL_OTP_SECRET", "super-secret-otp")
    monkeypatch.setenv("SMTP_HOST", "smtp.gmail.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("SMTP_USE_TLS", "true")

    response = client.get(
        "/api/admin/email/status",
        headers={"x-admin-token": "admin-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["configured"] is True
    assert payload["email_user_set"] is True
    assert payload["email_pass_set"] is True
    assert payload["email_otp_secret_set"] is True
    assert payload["masked_email_user"] == "ha***@example.com"
    text = response.text
    assert "harisender@example.com" not in text
    assert "super-secret-email-pass" not in text
    assert "super-secret-otp" not in text


def test_smtp_send_failure_returns_safe_503_cleans_up_otp_and_omits_raw_code_from_logs(
    client: TestClient,
    monkeypatch,
    caplog,
) -> None:
    _set_production_email_env(monkeypatch)
    _patch_firebase_exists(monkeypatch, False)
    sender = _patch_failing_email_sender(monkeypatch)
    caplog.set_level(logging.WARNING)

    response = client.post(
        "/auth/email-otp/signup/request",
        json={"email": "send-fail@example.com", "name": "Send Fail"},
        headers={"x-request-id": "req-send-fail"},
    )

    _assert_safe_email_delivery_detail(response, "email_delivery_unavailable")
    with SessionLocal() as session:
        records = session.exec(select(EmailOtpCode)).all()
    assert records == []
    assert sender.last_code
    assert sender.last_code not in response.text
    assert sender.last_code not in caplog.text
    assert "smtp-test-password" not in caplog.text
    assert "otp-test-secret" not in caplog.text
    delivery_record = next(
        record
        for record in caplog.records
        if getattr(record, "event", "") == "otp_email_delivery_send_failed"
    )
    assert getattr(delivery_record, "request_id") == "req-send-fail"
    assert getattr(delivery_record, "smtp_stage") == "login"
    assert getattr(delivery_record, "smtp_exception_class") == "SMTPAuthenticationError"


def test_admin_email_status_requires_admin_token_in_production(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DEBUG_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("ADMIN_EMAILS", "")

    response = client.get("/api/admin/email/status")

    assert response.status_code == 403


def test_admin_email_send_test_uses_fake_sender_and_hides_secrets(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DEBUG_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("ADMIN_EMAILS", "")
    monkeypatch.setenv("EMAIL_PASS", "super-secret-email-pass")
    monkeypatch.setenv("EMAIL_OTP_SECRET", "super-secret-otp")
    sender = _patch_email_sender(monkeypatch)

    response = client.post(
        "/api/admin/email/send-test",
        headers={"x-admin-token": "admin-token"},
        json={"to_email": "admin@example.com"},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert sender.sent == [
        {
            "to_email": "admin@example.com",
            "subject": "Swico email delivery test",
            "text_body": "Email delivery is configured.",
        }
    ]
    assert "super-secret-email-pass" not in response.text
    assert "super-secret-otp" not in response.text


def test_startup_records_safe_email_delivery_runtime_status(
    monkeypatch,
    caplog,
) -> None:
    monkeypatch.setattr(main_module, "APP_ENV", "production")
    monkeypatch.setenv("AUTH_ALLOW_DEV_TOKENS", "false")
    monkeypatch.setenv("EMAIL_USER", "runtime@example.com")
    monkeypatch.setenv("EMAIL_PASS", "runtime-secret-pass")
    monkeypatch.setenv("EMAIL_FROM", "runtime@example.com")
    monkeypatch.delenv("EMAIL_OTP_SECRET", raising=False)
    caplog.set_level(logging.WARNING)

    main_module.startup_runtime_services()

    email_service = main_module.RUNTIME_STATUS["services"]["email_delivery"]
    assert email_service["ok"] is False
    assert email_service["required"] is False
    assert email_service["metadata"]["email_otp_secret_set"] is False
    assert "EMAIL_OTP_SECRET" in email_service["metadata"]["missing"]
    assert "runtime-secret-pass" not in caplog.text


def test_existing_protected_routes_still_require_auth(client: TestClient) -> None:
    response = client.get("/users/me")
    assert response.status_code == 401
