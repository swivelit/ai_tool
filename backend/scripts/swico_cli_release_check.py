"""Read-only Swico CLI rollout/readiness check.

This deliberately does not call Firebase, a model provider, or mutate the DB.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.cli_api.config import CliConfigurationError, validate_cli_configuration  # noqa: E402
from app.database import engine  # noqa: E402
from app.alembic_utils import repository_alembic_head  # noqa: E402
from sqlalchemy import inspect, text  # noqa: E402

REQUIRED_CLI_TABLES = frozenset({
    "cli_device_grant",
    "cli_session",
    "cli_agent_run",
    "cli_agent_step",
    "cli_pending_action",
})
PUBLIC_CLI_WEB_ORIGIN = "https://swico.in"


def rollout_configuration_errors(settings, *, public: bool = False) -> list[str]:
    """Return safe, non-secret configuration errors for the requested rollout."""
    if not public:
        return []
    errors: list[str] = []
    if not settings.enabled:
        errors.append("SWICO_CLI_ENABLED must be true for public rollout")
    if settings.allowed_emails:
        errors.append("SWICO_CLI_ALLOWED_EMAILS must be empty for public rollout")
    if settings.agent_enabled:
        errors.append("SWICO_CLI_AGENT_ENABLED must be false for public rollout")
    if settings.cloud_agent_enabled:
        errors.append("SWICO_CLI_CLOUD_AGENT_ENABLED must be false for public rollout")
    if settings.web_origin != PUBLIC_CLI_WEB_ORIGIN:
        errors.append("SWICO_CLI_WEB_ORIGIN must be https://swico.in for public rollout")
    return errors


def schema_readiness_errors(
    present_tables: set[str] | frozenset[str],
    database_revision: str | None,
    repository_head: str | None,
) -> list[str]:
    """Return safe schema errors without exposing connection details."""
    missing = sorted(REQUIRED_CLI_TABLES - set(present_tables))
    errors = []
    if missing:
        errors.append("required CLI tables are missing")
    if not repository_head or database_revision != repository_head:
        errors.append("database Alembic revision does not match repository head")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Swico CLI configuration and schema readiness.")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument(
        "--public",
        action="store_true",
        help="require the unallowlisted public paid-CLI rollout configuration",
    )
    args = parser.parse_args()
    output: dict[str, object] = {
        "check": "swico_cli",
        "paid_provider_request": False,
        "rollout": "public" if args.public else "staged",
    }
    try:
        settings = validate_cli_configuration()
        output.update({
            "status": "ready" if settings.enabled else "disabled",
            "enabled": settings.enabled,
            "agent_enabled": settings.agent_enabled,
            "cloud_agent_enabled": settings.cloud_agent_enabled,
            "cloud_runner": "not configured; API never executes repository code",
            "web_origin": settings.web_origin,
            "allowlist_configured": bool(settings.allowed_emails),
            "max_agent_steps": settings.max_agent_steps,
            "device_grant_seconds": settings.device_grant_seconds,
            "access_token_seconds": settings.access_token_seconds,
            "session_max_seconds": settings.session_max_seconds,
            "action_retention_seconds": settings.action_retention_seconds,
        })
        configuration_errors = rollout_configuration_errors(settings, public=args.public)
        if args.public:
            output["public_rollout_errors"] = configuration_errors
    except CliConfigurationError as exc:
        output.update({"status": "invalid", "error": str(exc)})
        print(json.dumps(output, indent=2 if args.pretty else None, sort_keys=True))
        return 2
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            present = REQUIRED_CLI_TABLES.intersection(inspector.get_table_names())
            db_revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one_or_none()
        repository_head = repository_alembic_head()
        schema_errors = schema_readiness_errors(present, db_revision, repository_head)
        output["schema"] = {
            "required_tables_present": sorted(present),
            "required_table_count": len(present),
            "head": repository_head,
            "database_revision": db_revision,
            "errors": schema_errors,
        }
    except Exception as exc:
        output["schema"] = {"status": "unreachable_or_not_migrated", "error": type(exc).__name__}
        output["status"] = "not_ready" if output.get("enabled") else output["status"]
        print(json.dumps(output, indent=2 if args.pretty else None, sort_keys=True))
        return 1 if args.public or output.get("enabled") else 0
    ready = not schema_errors and not settings.cloud_agent_enabled
    if args.public:
        ready = ready and not configuration_errors
    output["ready"] = ready if output.get("enabled") or args.public else None
    if output.get("enabled") and not ready:
        output["status"] = "not_ready"
    print(json.dumps(output, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if ((not output.get("enabled") and not args.public) or ready) else 1


if __name__ == "__main__":
    raise SystemExit(main())
