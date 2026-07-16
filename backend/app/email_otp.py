from __future__ import annotations

import hmac
import math
import os
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import HTTPException
from sqlmodel import Session, select

from .auth import is_production_environment
from .models import EmailOtpCode
from .time_utils import ensure_utc, utc_now

OtpPurpose = Literal["signup", "password_reset"]

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
OTP_RE = re.compile(r"^\d{6}$")

DEFAULT_TTL_SECONDS = 600
DEFAULT_COOLDOWN_SECONDS = 60
DEFAULT_MAX_ATTEMPTS = 5


class EmailOtpConfigurationError(RuntimeError):
    pass


class EmailOtpError(ValueError):
    def __init__(self, message: str, *, code: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class OtpSettings:
    ttl_seconds: int
    cooldown_seconds: int
    max_attempts: int
    dev_return_code: bool


@dataclass(frozen=True)
class StoredOtpResult:
    record: EmailOtpCode
    code: str
    cooldown_seconds: int
    expires_at: datetime


def _positive_int_env(name: str, default: int) -> int:
    try:
        parsed = int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def get_otp_settings() -> OtpSettings:
    return OtpSettings(
        ttl_seconds=_positive_int_env("EMAIL_OTP_TTL_SECONDS", DEFAULT_TTL_SECONDS),
        cooldown_seconds=_positive_int_env(
            "EMAIL_OTP_COOLDOWN_SECONDS",
            DEFAULT_COOLDOWN_SECONDS,
        ),
        max_attempts=_positive_int_env(
            "EMAIL_OTP_MAX_ATTEMPTS",
            DEFAULT_MAX_ATTEMPTS,
        ),
        dev_return_code=_env_bool("EMAIL_OTP_DEV_RETURN_CODE", False),
    )


def normalize_email(email: str | None) -> str:
    return str(email or "").strip().lower()


def is_valid_email(email: str | None) -> bool:
    normalized = normalize_email(email)
    return len(normalized) <= 254 and bool(EMAIL_RE.fullmatch(normalized))


def require_valid_email(email: str | None) -> str:
    normalized = normalize_email(email)
    if not is_valid_email(normalized):
        raise EmailOtpError(
            "Please enter a valid email address.",
            code="invalid_email",
            status_code=400,
        )
    return normalized


def normalize_purpose(purpose: str) -> OtpPurpose:
    normalized = str(purpose or "").strip().lower()
    if normalized not in {"signup", "password_reset"}:
        raise ValueError("invalid OTP purpose")
    return normalized  # type: ignore[return-value]


def generate_otp() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def validate_otp_format(otp: str | None) -> str:
    normalized = str(otp or "").strip()
    if not OTP_RE.fullmatch(normalized):
        raise EmailOtpError(
            "Enter the 6-digit code from your email.",
            code="invalid_otp_format",
            status_code=400,
        )
    return normalized


def get_otp_secret() -> str:
    secret = os.getenv("EMAIL_OTP_SECRET", "").strip()
    if secret:
        return secret

    fallback = (
        os.getenv("DOWNLOAD_TOKEN_SECRET", "").strip()
        or os.getenv("SECRET_KEY", "").strip()
    )
    if fallback and not is_production_environment():
        return fallback

    if is_production_environment():
        raise EmailOtpConfigurationError("EMAIL_OTP_SECRET must be set in production.")

    return "dev-email-otp-secret"


def hash_otp(email: str, purpose: str, otp: str, secret: str | None = None) -> str:
    normalized_email = require_valid_email(email)
    normalized_purpose = normalize_purpose(purpose)
    normalized_otp = validate_otp_format(otp)
    key = (secret or get_otp_secret()).encode("utf-8")
    payload = f"{normalized_purpose}:{normalized_email}:{normalized_otp}".encode("utf-8")
    return hmac.new(key, payload, "sha256").hexdigest()


def verify_otp_hash(
    *,
    email: str,
    purpose: str,
    otp: str,
    expected_hash: str,
    secret: str | None = None,
) -> bool:
    actual = hash_otp(email, purpose, otp, secret)
    return hmac.compare_digest(actual, str(expected_hash or ""))


def expiry_from(now: datetime | None = None, ttl_seconds: int | None = None) -> datetime:
    current = ensure_utc(now or utc_now())
    ttl = get_otp_settings().ttl_seconds if ttl_seconds is None else ttl_seconds
    return current + timedelta(seconds=ttl)


def seconds_until_resend_allowed(
    last_sent_at: datetime | None,
    *,
    now: datetime | None = None,
    cooldown_seconds: int | None = None,
) -> int:
    if last_sent_at is None:
        return 0

    current = ensure_utc(now or utc_now())
    sent_at = ensure_utc(last_sent_at)
    cooldown = (
        get_otp_settings().cooldown_seconds
        if cooldown_seconds is None
        else cooldown_seconds
    )
    # Treat a future send time as zero elapsed time. This tolerates minor clock
    # skew without reducing the cooldown or allowing an early resend.
    elapsed = max(0.0, (current - sent_at).total_seconds())
    remaining = cooldown - elapsed
    return max(0, math.ceil(remaining))


def can_return_dev_code() -> bool:
    settings = get_otp_settings()
    return settings.dev_return_code and not is_production_environment()


def _latest_active_code(
    session: Session,
    *,
    email: str,
    purpose: OtpPurpose,
    now: datetime,
) -> Optional[EmailOtpCode]:
    current = ensure_utc(now)
    record = session.exec(
        select(EmailOtpCode)
        .where(EmailOtpCode.email == email)
        .where(EmailOtpCode.purpose == purpose)
        .where(EmailOtpCode.consumed_at.is_(None))
        .where(EmailOtpCode.expires_at > current)
        .order_by(EmailOtpCode.created_at.desc(), EmailOtpCode.id.desc())
    ).first()
    if record is None:
        return None

    # SQLite and legacy PostgreSQL schemas can return naive values. Normalize
    # every loaded OTP timestamp at this application boundary before use.
    record.created_at = ensure_utc(record.created_at)
    record.expires_at = ensure_utc(record.expires_at)
    record.last_sent_at = ensure_utc(record.last_sent_at)
    if record.consumed_at is not None:
        record.consumed_at = ensure_utc(record.consumed_at)

    if record.expires_at <= current:
        return None
    return record


def assert_resend_allowed(
    session: Session,
    *,
    email: str,
    purpose: OtpPurpose,
    now: datetime | None = None,
    cooldown_seconds: int | None = None,
) -> None:
    current = ensure_utc(now or utc_now())
    active = _latest_active_code(session, email=email, purpose=purpose, now=current)
    if not active:
        return

    remaining = seconds_until_resend_allowed(
        active.last_sent_at,
        now=current,
        cooldown_seconds=cooldown_seconds,
    )
    if remaining > 0:
        raise EmailOtpError(
            f"Please wait {remaining} seconds before requesting another code.",
            code="otp_cooldown",
            status_code=429,
        )


def create_otp_code(
    session: Session,
    *,
    email: str,
    purpose: str,
    now: datetime | None = None,
    settings: OtpSettings | None = None,
    commit: bool = True,
) -> StoredOtpResult:
    normalized_email = require_valid_email(email)
    normalized_purpose = normalize_purpose(purpose)
    resolved_settings = settings or get_otp_settings()
    current = ensure_utc(now or utc_now())

    assert_resend_allowed(
        session,
        email=normalized_email,
        purpose=normalized_purpose,
        now=current,
        cooldown_seconds=resolved_settings.cooldown_seconds,
    )

    code = generate_otp()
    record = EmailOtpCode(
        email=normalized_email,
        purpose=normalized_purpose,
        otp_hash=hash_otp(normalized_email, normalized_purpose, code),
        created_at=current,
        expires_at=current + timedelta(seconds=resolved_settings.ttl_seconds),
        last_sent_at=current,
        attempts=0,
    )
    session.add(record)
    if commit:
        session.commit()
    else:
        session.flush()
    session.refresh(record)
    record.created_at = ensure_utc(record.created_at)
    record.expires_at = ensure_utc(record.expires_at)
    record.last_sent_at = ensure_utc(record.last_sent_at)
    return StoredOtpResult(
        record=record,
        code=code,
        cooldown_seconds=resolved_settings.cooldown_seconds,
        expires_at=ensure_utc(record.expires_at),
    )


def verify_and_consume_otp(
    session: Session,
    *,
    email: str,
    purpose: str,
    otp: str,
    now: datetime | None = None,
    max_attempts: int | None = None,
) -> EmailOtpCode:
    normalized_email = require_valid_email(email)
    normalized_purpose = normalize_purpose(purpose)
    normalized_otp = validate_otp_format(otp)
    current = ensure_utc(now or utc_now())
    attempts_limit = max_attempts or get_otp_settings().max_attempts

    record = _latest_active_code(
        session,
        email=normalized_email,
        purpose=normalized_purpose,
        now=current,
    )
    if not record:
        raise EmailOtpError(
            "This code is invalid or expired. Request a new code.",
            code="otp_invalid_or_expired",
            status_code=400,
        )

    if record.attempts >= attempts_limit:
        record.consumed_at = current
        session.add(record)
        session.commit()
        raise EmailOtpError(
            "Too many incorrect attempts. Request a new code.",
            code="otp_too_many_attempts",
            status_code=429,
        )

    if not verify_otp_hash(
        email=normalized_email,
        purpose=normalized_purpose,
        otp=normalized_otp,
        expected_hash=record.otp_hash,
    ):
        record.attempts += 1
        if record.attempts >= attempts_limit:
            record.consumed_at = current
            session.add(record)
            session.commit()
            raise EmailOtpError(
                "Too many incorrect attempts. Request a new code.",
                code="otp_too_many_attempts",
                status_code=429,
            )
        session.add(record)
        session.commit()
        raise EmailOtpError(
            "The code you entered is incorrect.",
            code="otp_incorrect",
            status_code=400,
        )

    record.consumed_at = current
    session.add(record)
    session.commit()
    session.refresh(record)
    record.created_at = ensure_utc(record.created_at)
    record.expires_at = ensure_utc(record.expires_at)
    record.last_sent_at = ensure_utc(record.last_sent_at)
    if record.consumed_at is not None:
        record.consumed_at = ensure_utc(record.consumed_at)
    return record


def otp_http_exception(error: EmailOtpError) -> HTTPException:
    return HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": str(error)},
    )
