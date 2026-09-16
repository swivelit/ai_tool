from __future__ import annotations

from app.cli_api.config import validate_cli_configuration
from scripts.swico_cli_release_check import (
    REQUIRED_CLI_TABLES,
    rollout_configuration_errors,
    schema_readiness_errors,
)


def _settings(**overrides):
    values = {
        "SWICO_CLI_ENABLED": "true",
        "SWICO_CLI_WEB_ORIGIN": "https://swico.in",
        "SWICO_CLI_AGENT_ENABLED": "false",
        "SWICO_CLI_CLOUD_AGENT_ENABLED": "false",
        "SWICO_CLI_MAX_AGENT_STEPS": "8",
    }
    values.update(overrides)
    return validate_cli_configuration(values)


def test_staged_rollout_allows_a_nonempty_tester_allowlist() -> None:
    settings = _settings(SWICO_CLI_ALLOWED_EMAILS="tester@example.com")
    assert rollout_configuration_errors(settings, public=False) == []


def test_public_rollout_requires_enabled_unallowlisted_chat_only_configuration() -> None:
    assert rollout_configuration_errors(_settings(), public=True) == []
    invalid_public_settings = [
        _settings(SWICO_CLI_ENABLED="false"),
        _settings(SWICO_CLI_ALLOWED_EMAILS="tester@example.com"),
        _settings(SWICO_CLI_AGENT_ENABLED="true"),
        _settings(SWICO_CLI_CLOUD_AGENT_ENABLED="true"),
        _settings(SWICO_CLI_WEB_ORIGIN="https://www.swico.in"),
    ]
    errors = [
        rollout_configuration_errors(settings, public=True)[0]
        for settings in invalid_public_settings
    ]
    assert len(errors) == 5
    assert all("@" not in error for error in errors)


def test_agent_pilot_requires_explicit_restricted_agent_configuration() -> None:
    settings = _settings(
        SWICO_CLI_AGENT_ENABLED="true",
        SWICO_CLI_AGENT_ALLOWED_EMAILS=" Pilot@Example.com ",
    )
    assert rollout_configuration_errors(settings, agent_pilot=True, environ={}) == []
    missing_allowlist = rollout_configuration_errors(
        _settings(SWICO_CLI_AGENT_ENABLED="true"), agent_pilot=True, environ={},
    )
    assert missing_allowlist == ["SWICO_CLI_AGENT_ALLOWED_EMAILS must be non-empty for agent pilot"]
    disabled = rollout_configuration_errors(
        _settings(SWICO_CLI_AGENT_ALLOWED_EMAILS="pilot@example.com"), agent_pilot=True, environ={},
    )
    assert "SWICO_CLI_AGENT_ENABLED must be true for agent pilot" in disabled


def test_agent_pilot_rejects_development_auth_bypass_without_exposing_values() -> None:
    settings = _settings(
        SWICO_CLI_AGENT_ENABLED="true",
        SWICO_CLI_AGENT_ALLOWED_EMAILS="pilot@example.com",
    )
    errors = rollout_configuration_errors(
        settings, agent_pilot=True, environ={"AUTH_ALLOW_DEV_TOKENS": "true"},
    )
    assert errors == ["AUTH_ALLOW_DEV_TOKENS must be false for agent pilot"]


def test_cloud_pilot_requires_verified_runner_without_blocking_public_chat() -> None:
    assert rollout_configuration_errors(_settings(), public=True) == []
    settings = _settings(
        SWICO_CLI_AGENT_ENABLED="true", SWICO_CLI_CLOUD_AGENT_ENABLED="true",
        SWICO_CLI_AGENT_ALLOWED_EMAILS="pilot@example.com",
    )
    errors = rollout_configuration_errors(settings, cloud_pilot=True, environ={})
    assert "cloud runner URL and credential must be configured for cloud pilot" in errors
    assert "cloud runner handshake must be verified for cloud pilot" in errors
    ready = _settings(
        SWICO_CLI_AGENT_ENABLED="true", SWICO_CLI_CLOUD_AGENT_ENABLED="true",
        SWICO_CLI_AGENT_ALLOWED_EMAILS="pilot@example.com",
        SWICO_CLI_CLOUD_RUNNER_URL="https://runner.example.test",
        SWICO_CLI_CLOUD_RUNNER_TOKEN="synthetic", SWICO_CLI_CLOUD_RUNNER_HANDSHAKE="true",
    )
    assert rollout_configuration_errors(ready, cloud_pilot=True, environ={}) == []


def test_public_schema_check_requires_all_cli_tables_and_repository_head() -> None:
    head = "20260915_weekly_tester_credit"
    assert schema_readiness_errors(REQUIRED_CLI_TABLES, head, head) == []
    errors = schema_readiness_errors({"cli_session"}, "old-head", head)
    assert errors == [
        "required CLI tables are missing",
        "database Alembic revision does not match repository head",
    ]
