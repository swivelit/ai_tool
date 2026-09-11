from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import re


def random_secret(bytes_count: int = 32) -> str:
    return secrets.token_urlsafe(bytes_count)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def human_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(2))


def verify_code_challenge(verifier: str, challenge: str) -> bool:
    encoded = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode("ascii")).digest()
    ).rstrip(b"=").decode("ascii")
    return hmac.compare_digest(encoded, challenge)


def valid_code_verifier(value: str) -> bool:
    return 43 <= len(value) <= 128 and all(
        char.isalnum() or char in "-._~" for char in value
    )


def valid_code_challenge(value: str) -> bool:
    """Accept the RFC 7636 S256 challenge shape, not arbitrary text."""
    return bool(
        re.fullmatch(r"[A-Za-z0-9_-]{43,128}", str(value or ""))
    )
