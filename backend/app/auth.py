from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from fastapi import Header, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from .models import User

logger = logging.getLogger(__name__)


class AuthUser(BaseModel):
    firebase_uid: str
    email: Optional[str] = None
    email_verified: bool = False


class AuthConfigurationError(RuntimeError):
    pass


PRODUCTION_FIREBASE_ADMIN_REQUIRED_MESSAGE = (
    "Firebase Admin credentials are required in production. Set "
    "FIREBASE_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS."
)

PRODUCTION_FIREBASE_ADMIN_AMBIGUOUS_MESSAGE = (
    "Configure exactly one of FIREBASE_CREDENTIALS_JSON or "
    "GOOGLE_APPLICATION_CREDENTIALS in production, not both."
)

FIREBASE_ADMIN_NOT_CONFIGURED_MESSAGE = (
    "Firebase Admin credentials are not configured. Set "
    "FIREBASE_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS."
)


def _env_enabled(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _normalized_email(value: str | None) -> str:
    return str(value or "").strip().casefold()


def is_internal_test_email(email: str | None) -> bool:
    """Return whether an exact normalized email is on the backend-only allowlist."""
    normalized = _normalized_email(email)
    if not normalized:
        return False
    allowed = {
        _normalized_email(item)
        for item in os.getenv("SWICO_INTERNAL_TEST_EMAILS", "").split(",")
        if _normalized_email(item)
    }
    return normalized in allowed


def is_internal_test_user(auth_user: AuthUser, user: User) -> bool:
    """Require a verified token email to exactly match the owned database user."""
    token_email = _normalized_email(auth_user.email)
    owned_email = _normalized_email(user.email)
    return bool(
        auth_user.email_verified
        and token_email
        and token_email == owned_email
        and is_internal_test_email(token_email)
    )


def normalize_app_env(value: str | None = None) -> str:
    raw = value
    if raw is None:
        raw = os.getenv("APP_ENV", os.getenv("ENVIRONMENT", "development"))
    return str(raw or "development").strip().lower()


def is_production_environment(value: str | None = None) -> bool:
    return normalize_app_env(value) in {"prod", "production"}


def _dev_token_allowed() -> bool:
    return _env_enabled("AUTH_ALLOW_DEV_TOKENS")


def _firebase_credentials_json_payload() -> dict[str, Any] | None:
    credentials_json = os.getenv("FIREBASE_CREDENTIALS_JSON", "").strip()
    if not credentials_json:
        return None

    try:
        payload = json.loads(credentials_json)
    except json.JSONDecodeError:
        raise AuthConfigurationError("FIREBASE_CREDENTIALS_JSON is invalid JSON.") from None

    if not isinstance(payload, dict):
        raise AuthConfigurationError("FIREBASE_CREDENTIALS_JSON must be a JSON object.")

    return payload


def _google_application_credentials_path() -> str | None:
    credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if not credentials_path:
        return None

    if not Path(credentials_path).is_file():
        raise AuthConfigurationError("GOOGLE_APPLICATION_CREDENTIALS file does not exist.")

    return credentials_path


def validate_auth_configuration(app_env: str | None = None) -> None:
    production = is_production_environment(app_env)

    if production and _dev_token_allowed():
        raise AuthConfigurationError(
            "AUTH_ALLOW_DEV_TOKENS must be disabled in production."
        )

    credentials_json_configured = bool(os.getenv("FIREBASE_CREDENTIALS_JSON", "").strip())
    credentials_path_configured = bool(os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip())

    if production and credentials_json_configured and credentials_path_configured:
        raise AuthConfigurationError(PRODUCTION_FIREBASE_ADMIN_AMBIGUOUS_MESSAGE)

    if credentials_json_configured:
        _firebase_credentials_json_payload()
    if credentials_path_configured:
        _google_application_credentials_path()

    if production and not (credentials_json_configured or credentials_path_configured):
        raise AuthConfigurationError(PRODUCTION_FIREBASE_ADMIN_REQUIRED_MESSAGE)


def _adc_environment_present() -> bool:
    return any(
        os.getenv(name, "").strip()
        for name in (
            "GOOGLE_CLOUD_PROJECT",
            "GCP_PROJECT",
            "GCLOUD_PROJECT",
            "FIREBASE_CONFIG",
        )
    )


def firebase_auth_runtime_status() -> dict[str, Any]:
    credentials_json_set = bool(os.getenv("FIREBASE_CREDENTIALS_JSON", "").strip())
    credentials_path_set = bool(os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip())
    adc_environment_set = _adc_environment_present()
    dev_tokens_enabled = _dev_token_allowed()
    firebase_admin_configured = credentials_json_set or credentials_path_set

    return {
        "firebase_admin_configured": firebase_admin_configured,
        "token_verification_configured": firebase_admin_configured or dev_tokens_enabled,
        "credentials_json_set": credentials_json_set,
        "credentials_path_set": credentials_path_set,
        "application_default_credentials_environment_set": adc_environment_set,
        "dev_tokens_enabled": dev_tokens_enabled,
        "initialized": bool(_get_firebase_admin_apps()),
    }


def _get_firebase_admin_apps() -> list[Any]:
    try:
        import firebase_admin
    except Exception:
        return []

    return list(getattr(firebase_admin, "_apps", {}) or {})


def _looks_like_firebase_configuration_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(
        marker in message
        for marker in (
            "application default credentials",
            "could not automatically determine credentials",
            "credentials",
            "project id",
            "service account",
            "default app",
        )
    )


@lru_cache(maxsize=1)
def _firebase_auth_module():
    cred_payload = _firebase_credentials_json_payload()
    credentials_path = _google_application_credentials_path()

    if cred_payload is None and not credentials_path:
        raise AuthConfigurationError(FIREBASE_ADMIN_NOT_CONFIGURED_MESSAGE)

    try:
        import firebase_admin
        from firebase_admin import auth as firebase_auth
        from firebase_admin import credentials
    except Exception as exc:  # pragma: no cover - depends on deployment environment
        raise AuthConfigurationError(
            "firebase-admin is not installed. Add firebase-admin to backend requirements."
        ) from exc

    if not firebase_admin._apps:
        try:
            if cred_payload is not None:
                firebase_admin.initialize_app(credentials.Certificate(cred_payload))
            elif credentials_path:
                firebase_admin.initialize_app(credentials.Certificate(credentials_path))
        except AuthConfigurationError:
            raise
        except Exception:
            raise AuthConfigurationError(
                "Firebase Admin could not initialize. Check FIREBASE_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS."
            ) from None

    return firebase_auth


def verify_firebase_id_token(token: str) -> dict[str, Any]:
    """Verify a Firebase ID token and return the decoded claims.

    Local tests can opt into deterministic tokens with AUTH_ALLOW_DEV_TOKENS=true
    and Authorization: Bearer dev:<firebase_uid>[:<email>]. Do not enable that in prod.
    """
    validate_auth_configuration()

    if _dev_token_allowed() and token.startswith("dev:"):
        _, uid, *rest = token.split(":")
        uid = uid.strip()
        if not uid:
            raise ValueError("empty dev uid")
        email = rest[0].strip() if rest else None
        # Development tokens exist only outside production. Treat their optional
        # email as verified so tests can exercise the same authorization path.
        return {"uid": uid, "email": email or None, "email_verified": bool(email)}

    firebase_auth = _firebase_auth_module()
    try:
        return firebase_auth.verify_id_token(token, check_revoked=True)
    except Exception as exc:
        if _looks_like_firebase_configuration_error(exc):
            raise AuthConfigurationError(
                "Firebase Admin token verification is not configured correctly. Check FIREBASE_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS."
            ) from exc
        raise


def get_firebase_user_by_email(email: str) -> Any | None:
    normalized_email = str(email or "").strip().lower()
    if not normalized_email:
        return None

    firebase_auth = _firebase_auth_module()
    try:
        return firebase_auth.get_user_by_email(normalized_email)
    except Exception as exc:
        if exc.__class__.__name__ == "UserNotFoundError":
            return None
        if _looks_like_firebase_configuration_error(exc):
            raise AuthConfigurationError(
                "Firebase Admin user lookup is not configured correctly. Check FIREBASE_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS."
            ) from exc
        raise


def firebase_user_exists_by_email(email: str) -> bool:
    return get_firebase_user_by_email(email) is not None


def create_firebase_email_password_user(
    *,
    email: str,
    password: str,
    display_name: str,
    email_verified: bool = True,
) -> dict[str, Any]:
    firebase_auth = _firebase_auth_module()
    user = firebase_auth.create_user(
        email=str(email or "").strip().lower(),
        password=password,
        display_name=display_name.strip() or None,
        email_verified=email_verified,
    )
    return {
        "uid": str(getattr(user, "uid", "") or ""),
        "email": str(getattr(user, "email", "") or email).strip().lower(),
        "email_verified": bool(getattr(user, "email_verified", email_verified)),
    }


def update_firebase_user_password_by_email(*, email: str, new_password: str) -> dict[str, Any]:
    firebase_auth = _firebase_auth_module()
    user = get_firebase_user_by_email(email)
    if user is None:
        raise ValueError("Firebase user not found")

    updated = firebase_auth.update_user(getattr(user, "uid"), password=new_password)
    return {
        "uid": str(getattr(updated, "uid", getattr(user, "uid", "")) or ""),
        "email": str(getattr(updated, "email", email) or email).strip().lower(),
    }


def revoke_firebase_refresh_tokens_by_email(email: str) -> bool:
    firebase_auth = _firebase_auth_module()
    user = get_firebase_user_by_email(email)
    if user is None:
        return False

    firebase_auth.revoke_refresh_tokens(getattr(user, "uid"))
    return True


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
        logger.warning("Firebase token verification failed", exc_info=True)
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
        email_verified=bool(decoded.get("email_verified")),
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
