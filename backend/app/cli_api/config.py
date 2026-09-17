from __future__ import annotations

from dataclasses import dataclass
import os
from urllib.parse import urlparse

from .runner_attestation import verify_runner_attestation


class CliConfigurationError(RuntimeError):
    pass


def _bool(name: str, default: bool = False, environ: dict[str, str] | None = None) -> bool:
    raw = (environ if environ is not None else os.environ).get(name)
    return default if raw is None else raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int, minimum: int, maximum: int, environ: dict[str, str] | None = None) -> int:
    raw = (environ if environ is not None else os.environ).get(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise CliConfigurationError(f"{name} must be an integer.") from exc
    if not minimum <= value <= maximum:
        raise CliConfigurationError(f"{name} must be between {minimum} and {maximum}.")
    return value


@dataclass(frozen=True)
class CliSettings:
    enabled: bool
    agent_enabled: bool
    web_origin: str
    allowed_emails: frozenset[str]
    agent_allowed_emails: frozenset[str]
    max_agent_steps: int
    agent_run_seconds: int = 300
    device_grant_seconds: int = 600
    poll_interval_seconds: int = 5
    access_token_seconds: int = 900
    session_max_seconds: int = 30 * 24 * 60 * 60
    action_retention_seconds: int = 300
    cloud_agent_enabled: bool = False
    cloud_runner_url: str = ""
    cloud_runner_configured: bool = False
    cloud_runner_identity_configured: bool = False
    cloud_runner_handshake: bool = False
    cloud_runner_transport: str = "https"
    cloud_runner_private_host: str = ""


TIER_AGENT_STEP_CEILINGS = {"lite": 12, "standard": 20, "pro": 32, "free": 0}


def agent_step_ceiling(tier: str) -> int:
    return TIER_AGENT_STEP_CEILINGS.get(tier, 0)


def cli_settings(environ: dict[str, str] | None = None) -> CliSettings:
    values = environ if environ is not None else os.environ
    enabled = _bool("SWICO_CLI_ENABLED", False, values)
    agent_enabled = _bool("SWICO_CLI_AGENT_ENABLED", False, values)
    cloud_agent_enabled = _bool("SWICO_CLI_CLOUD_AGENT_ENABLED", False, values)
    cloud_runner_url = values.get("SWICO_CLI_CLOUD_RUNNER_URL", "").strip().rstrip("/")
    cloud_runner_transport = values.get("SWICO_CLI_CLOUD_RUNNER_TRANSPORT", "https").strip().lower() or "https"
    cloud_runner_private_host = values.get("SWICO_CLI_CLOUD_RUNNER_PRIVATE_HOST", "").strip().lower()
    cloud_runner_token = values.get("SWICO_CLI_CLOUD_RUNNER_TOKEN", "").strip()
    # The legacy boolean is intentionally ignored.  Readiness requires fresh,
    # signed runner evidence bound to the runner-control secret.
    cloud_runner_attestation = values.get("SWICO_CLI_CLOUD_RUNNER_ATTESTATION", "").strip()
    cloud_runner_handshake = verify_runner_attestation(
        cloud_runner_attestation,
        secret=cloud_runner_token,
        expected={
            "runner_id": values.get("SWICO_CLI_CLOUD_RUNNER_ID", "").strip(),
            "audience": values.get("SWICO_CLI_CLOUD_RUNNER_AUDIENCE", "").strip(),
            "executor": values.get("SWICO_CLI_CLOUD_RUNNER_EXECUTOR", "").strip(),
            "template_id_or_digest": values.get("SWICO_CLI_CLOUD_TEMPLATE", "").strip(),
            "runner_revision": values.get("SWICO_CLI_CLOUD_RUNNER_REVISION", "").strip(),
            "policy_sha256": values.get("SWICO_CLI_CLOUD_POLICY_SHA256", "").strip(),
            "network_policy": values.get("SWICO_CLI_CLOUD_NETWORK_POLICY", "").strip(),
        },
    )
    cloud_identity = {
        "runner_id": values.get("SWICO_CLI_CLOUD_RUNNER_ID", "").strip(),
        "audience": values.get("SWICO_CLI_CLOUD_RUNNER_AUDIENCE", "").strip(),
        "executor": values.get("SWICO_CLI_CLOUD_RUNNER_EXECUTOR", "").strip(),
        "template_id_or_digest": values.get("SWICO_CLI_CLOUD_TEMPLATE", "").strip(),
        "runner_revision": values.get("SWICO_CLI_CLOUD_RUNNER_REVISION", "").strip(),
        "policy_sha256": values.get("SWICO_CLI_CLOUD_POLICY_SHA256", "").strip(),
        "network_policy": values.get("SWICO_CLI_CLOUD_NETWORK_POLICY", "").strip(),
    }
    if cloud_runner_url:
        runner_parsed = urlparse(cloud_runner_url)
        private_http = cloud_runner_transport == "render_private_http" and runner_parsed.scheme == "http" and bool(cloud_runner_private_host) and runner_parsed.hostname == cloud_runner_private_host
        if (runner_parsed.scheme != "https" and not private_http) or runner_parsed.username or runner_parsed.password or runner_parsed.query or runner_parsed.fragment:
            raise CliConfigurationError("SWICO_CLI_CLOUD_RUNNER_URL must be HTTPS, or the exact configured Render-private HTTP host, without credentials or query parameters.")
    if cloud_runner_transport not in {"https", "render_private_http"}:
        raise CliConfigurationError("SWICO_CLI_CLOUD_RUNNER_TRANSPORT must be https or render_private_http.")
    if cloud_runner_transport == "render_private_http" and cloud_runner_url and not cloud_runner_private_host:
        raise CliConfigurationError("SWICO_CLI_CLOUD_RUNNER_PRIVATE_HOST is required for Render-private HTTP transport.")
    origin = values.get("SWICO_CLI_WEB_ORIGIN", "https://swico.in").strip().rstrip("/")
    parsed = urlparse(origin)
    if parsed.scheme != "https" or parsed.hostname not in {"swico.in", "www.swico.in"} or parsed.username or parsed.password:
        raise CliConfigurationError("SWICO_CLI_WEB_ORIGIN must be a fixed HTTPS origin.")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise CliConfigurationError("SWICO_CLI_WEB_ORIGIN must not contain a path, query, or fragment.")
    allowlist = frozenset(
        item.strip().casefold()
        for item in values.get("SWICO_CLI_ALLOWED_EMAILS", "").split(",")
        if item.strip()
    )
    agent_allowlist = frozenset(
        item.strip().casefold()
        for item in values.get("SWICO_CLI_AGENT_ALLOWED_EMAILS", "").split(",")
        if item.strip()
    )
    max_steps = _int("SWICO_CLI_MAX_AGENT_STEPS", 8, 1, 32, values)
    agent_run_seconds = _int("SWICO_CLI_AGENT_RUN_SECONDS", 300, 60, 1800, values)
    # A disabled rollout is safe, but malformed limits must still be visible
    # to release checks instead of silently becoming an unlimited capability.
    return CliSettings(
        enabled=enabled,
        agent_enabled=agent_enabled,
        web_origin=origin,
        allowed_emails=allowlist,
        agent_allowed_emails=agent_allowlist,
        max_agent_steps=max_steps,
        agent_run_seconds=agent_run_seconds,
        cloud_agent_enabled=cloud_agent_enabled,
        cloud_runner_url=cloud_runner_url,
        cloud_runner_configured=bool(cloud_runner_url and cloud_runner_token),
        cloud_runner_identity_configured=all(cloud_identity.values()),
        cloud_runner_handshake=cloud_runner_handshake,
        cloud_runner_transport=cloud_runner_transport,
        cloud_runner_private_host=cloud_runner_private_host,
    )


def validate_cli_configuration(environ: dict[str, str] | None = None) -> CliSettings:
    settings = cli_settings(environ)
    if settings.agent_enabled and not settings.enabled:
        raise CliConfigurationError("SWICO_CLI_AGENT_ENABLED requires SWICO_CLI_ENABLED.")
    if settings.cloud_agent_enabled and not settings.enabled:
        raise CliConfigurationError("SWICO_CLI_CLOUD_AGENT_ENABLED requires SWICO_CLI_ENABLED.")
    return settings
