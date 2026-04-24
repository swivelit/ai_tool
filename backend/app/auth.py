from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from typing import Any, Optional

from fastapi import Header, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from .models import User

logger = logging.getLogger(__name__)


class AuthUser(BaseModel):
    firebase_uid: str
    email: Optional[str] = None


class AuthConfigurationError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _firebase_auth_module():
    try:
        import firebase_admin
        from firebase_admin import auth as firebase_auth
        from firebase_admin import credentials
    except Exception as exc:  # pragma: no cover - depends on deployment environment
        raise AuthConfigurationError(
            "firebase-admin is not installed. Add firebase-admin to backend requirements."
        ) from exc

    if not firebase_admin._apps:
        credentials_json = os.getenv("FIREBASE_CREDENTIALS_JSON", "").strip()
        credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()

        if credentials_json:
            try:
                cred_payload = json.loads(credentials_json)
            except json.JSONDecodeError as exc:
                raise AuthConfigurationError("FIREBASE_CREDENTIALS_JSON is invalid JSON.") from exc
            firebase_admin.initialize_app(credentials.Certificate(cred_payload))
        elif credentials_path:
            firebase_admin.initialize_app(credentials.Certificate(credentials_path))
        else:
            # Allows Google-managed runtime credentials / ADC in production.
            firebase_admin.initialize_app()

    return firebase_auth


def _dev_token_allowed() -> bool:
    return os.getenv("AUTH_ALLOW_DEV_TOKENS", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def verify_firebase_id_token(token: str) -> dict[str, Any]:
    """Verify a Firebase ID token and return the decoded claims.

    Local tests can opt into deterministic tokens with AUTH_ALLOW_DEV_TOKENS=true
    and Authorization: Bearer dev:<firebase_uid>[:<email>]. Do not enable that in prod.
    """
    if _dev_token_allowed() and token.startswith("dev:"):
        _, uid, *rest = token.split(":")
        uid = uid.strip()
        if not uid:
            raise ValueError("empty dev uid")
        email = rest[0].strip() if rest else None
        return {"uid": uid, "email": email or None}

    firebase_auth = _firebase_auth_module()
    return firebase_auth.verify_id_token(token, check_revoked=True)


async def get_current_user(
    authorization: str | None = Header(default=None),
) -> AuthUser:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing auth token",
        )

    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing auth token",
        )

    try:
        decoded = verify_firebase_id_token(token)
    except AuthConfigurationError as exc:
        logger.exception("Firebase auth is not configured")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid auth token",
        ) from exc

    firebase_uid = str(decoded.get("uid") or "").strip()
    if not firebase_uid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid auth token",
        )

    email = decoded.get("email")
    return AuthUser(
        firebase_uid=firebase_uid,
        email=str(email).strip().lower() if email else None,
    )


def get_owned_user(session: Session, auth_user: AuthUser) -> User:
    user = session.exec(
        select(User).where(User.firebase_uid == auth_user.firebase_uid)
    ).first()

    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return user


def assert_owner(user_id: int, user: User) -> None:
    if int(user.id or 0) != int(user_id):
        raise HTTPException(status_code=403, detail="Forbidden")
