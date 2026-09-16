from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.auth import AuthUser
from app.cli_api.config import validate_cli_configuration
from app.cli_api.router import _email_allowed, _require_cli_paid_tier


def _user(email: str = "paid@example.com"):
    return type("OwnedUser", (), {"email": email})()


def _settings(**overrides):
    values = {
        "SWICO_CLI_ENABLED": "true",
        "SWICO_CLI_WEB_ORIGIN": "https://swico.in",
        "SWICO_CLI_MAX_AGENT_STEPS": "8",
    }
    values.update(overrides)
    return validate_cli_configuration(values)


def test_empty_allowlist_allows_any_verified_owned_paid_identity() -> None:
    settings = _settings()
    assert _email_allowed(settings, AuthUser(firebase_uid="uid", email="PAID@example.com", email_verified=True), _user())
    assert not _email_allowed(settings, AuthUser(firebase_uid="uid", email="other@example.com", email_verified=True), _user())
    assert not _email_allowed(settings, AuthUser(firebase_uid="uid", email="paid@example.com", email_verified=False), _user())


def test_nonempty_allowlist_restricts_verified_owned_identity() -> None:
    settings = _settings(SWICO_CLI_ALLOWED_EMAILS="tester@example.com")
    assert _email_allowed(settings, AuthUser(firebase_uid="uid", email="tester@example.com", email_verified=True), _user("tester@example.com"))
    assert not _email_allowed(settings, AuthUser(firebase_uid="uid", email="paid@example.com", email_verified=True), _user())


@pytest.mark.parametrize("tier", ["lite", "standard"])
def test_lite_and_standard_are_cli_paid_tiers(tier: str) -> None:
    assert _require_cli_paid_tier(tier) == tier


def test_pro_requires_pro_enablement(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.cli_api.router.pro_enabled", lambda: False)
    with pytest.raises(HTTPException) as error:
        _require_cli_paid_tier("pro")
    assert error.value.status_code == 422
    monkeypatch.setattr("app.cli_api.router.pro_enabled", lambda: True)
    assert _require_cli_paid_tier("pro") == "pro"


def test_free_is_never_a_cli_paid_tier() -> None:
    with pytest.raises(HTTPException) as error:
        _require_cli_paid_tier("free")
    assert error.value.status_code == 403
