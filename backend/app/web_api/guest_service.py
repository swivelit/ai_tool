from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass
from datetime import timedelta

from fastapi import HTTPException, Request
from sqlmodel import Session, select

from ..billing.service import enforce_rate_limit_scope
from ..models import User, WebGuestSession, WebUsagePreferences
from ..time_utils import utc_now
from ..ai.swico_tiers import free_enabled

GUEST_TOKEN_HEADER = "X-Swico-Guest-Token"
GUEST_TOKEN_BYTES = 48


@dataclass(frozen=True)
class GuestIdentity:
    session_id: str
    user_id: int


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(maximum, max(minimum, value))


def guest_session_ttl_seconds() -> int:
    return _bounded_int_env("SWICO_GUEST_SESSION_TTL_SECONDS", 86_400, 900, 2_592_000)


def guest_session_creation_limit_per_hour() -> int:
    return _bounded_int_env(
        "SWICO_GUEST_SESSION_CREATION_RATE_LIMIT_PER_HOUR", 10, 1, 1000
    )


def _scope_hash_secret() -> bytes:
    # DOWNLOAD_TOKEN_SECRET/SECRET_KEY is already required in production. A
    # separate override is useful for key rotation without changing auth.
    value = (
        os.getenv("SWICO_GUEST_SCOPE_HASH_SECRET", "").strip()
        or os.getenv("DOWNLOAD_TOKEN_SECRET", "").strip()
        or os.getenv("SECRET_KEY", "").strip()
    )
    if not value:
        value = "swico-development-guest-scope-key"
    return value.encode("utf-8")


def trusted_client_scope(request: Request) -> str:
    """Return a keyed, non-reversible scope for the server-observed client.

    X-Forwarded-For is ignored unless the deployment explicitly declares the
    number of trusted proxy hops. With the default of zero, request.client is
    the only input, so a browser cannot choose its rate-limit identity.
    """
    observed = request.client.host if request.client is not None else "unknown"
    trusted_hops = _bounded_int_env("SWICO_TRUSTED_PROXY_HOPS", 0, 0, 10)
    if trusted_hops:
        forwarded = request.headers.get("x-forwarded-for", "")
        values = [item.strip() for item in forwarded.split(",") if item.strip()]
        if len(values) >= trusted_hops:
            observed = values[-trusted_hops]
    digest = hmac.new(_scope_hash_secret(), observed.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"guest_session_scope:v1:{digest}"


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _validate_token_shape(token: str | None) -> str:
    value = str(token or "").strip()
    if len(value) < 64 or len(value) > 256:
        raise HTTPException(401, "Invalid guest session")
    return value


def create_guest_session(session: Session, request: Request) -> tuple[str, WebGuestSession]:
    if not free_enabled():
        raise HTTPException(503, {
            "code": "swico_free_unavailable",
            "message": "Swico Free is temporarily unavailable. Please try again shortly.",
        })
    enforce_rate_limit_scope(
        session,
        scope_key=trusted_client_scope(request),
        action="guest_session_creation",
        limit=guest_session_creation_limit_per_hour(),
        window_seconds=3600,
    )
    now = utc_now()
    raw_token = secrets.token_urlsafe(GUEST_TOKEN_BYTES)
    user = User(
        name="Swico Guest", email=None, firebase_uid=None,
        timezone="UTC", assistant_name="Swico", reply_language="en",
    )
    session.add(user)
    session.flush()
    session.add(WebUsagePreferences(
        user_id=int(user.id), assistant_tier="free", memory_enabled=False,
    ))
    guest = WebGuestSession(
        user_id=int(user.id), token_digest=_token_digest(raw_token),
        created_at=now, last_seen_at=now,
        expires_at=now + timedelta(seconds=guest_session_ttl_seconds()),
    )
    session.add(guest)
    session.flush()
    # The raw token is returned by the route and never assigned to a model.
    return raw_token, guest


def resolve_guest_session(session: Session, token: str | None) -> GuestIdentity:
    raw_token = _validate_token_shape(token)
    now = utc_now()
    guest = session.exec(select(WebGuestSession).where(
        WebGuestSession.token_digest == _token_digest(raw_token),
        WebGuestSession.revoked_at.is_(None),
        WebGuestSession.expires_at > now,
    )).first()
    if guest is None:
        raise HTTPException(401, "Invalid or expired guest session")
    guest.last_seen_at = now
    session.add(guest)
    return GuestIdentity(session_id=str(guest.id), user_id=int(guest.user_id))


def revoke_guest_session(session: Session, identity: GuestIdentity) -> None:
    guest = session.get(WebGuestSession, identity.session_id)
    if guest is not None and int(guest.user_id) == int(identity.user_id):
        guest.revoked_at = utc_now()
        session.add(guest)
