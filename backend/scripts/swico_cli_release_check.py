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

from app.cli_api.config import CliConfigurationError, cli_settings  # noqa: E402
from app.database import engine  # noqa: E402
from app.alembic_utils import repository_alembic_head  # noqa: E402
from sqlalchemy import inspect, text  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Swico CLI configuration and schema readiness.")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    output: dict[str, object] = {"check": "swico_cli", "paid_provider_request": False}
    try:
        settings = cli_settings()
        output.update({
            "status": "ready" if settings.enabled else "disabled",
            "enabled": settings.enabled,
            "agent_enabled": settings.agent_enabled,
            "web_origin": settings.web_origin,
            "allowlist_configured": bool(settings.allowed_emails),
            "max_agent_steps": settings.max_agent_steps,
            "device_grant_seconds": settings.device_grant_seconds,
            "access_token_seconds": settings.access_token_seconds,
            "session_max_seconds": settings.session_max_seconds,
            "action_retention_seconds": settings.action_retention_seconds,
        })
    except CliConfigurationError as exc:
        output.update({"status": "invalid", "error": str(exc)})
        print(json.dumps(output, indent=2 if args.pretty else None, sort_keys=True))
        return 2
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            required = {"cli_device_grant", "cli_session", "cli_agent_run", "cli_agent_step", "cli_pending_action"}
            present = required.intersection(inspector.get_table_names())
            db_revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one_or_none()
        output["schema"] = {"required_tables_present": sorted(present), "required_table_count": len(present), "head": repository_alembic_head(), "database_revision": db_revision}
    except Exception as exc:
        output["schema"] = {"status": "unreachable_or_not_migrated", "error": type(exc).__name__}
        output["status"] = "not_ready" if output.get("enabled") else output["status"]
        print(json.dumps(output, indent=2 if args.pretty else None, sort_keys=True))
        return 1 if output.get("enabled") else 0
    ready = len(present) == 5 and db_revision == repository_alembic_head()
    output["ready"] = ready if output.get("enabled") else None
    if output.get("enabled") and not ready:
        output["status"] = "not_ready"
    print(json.dumps(output, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if (not output.get("enabled") or ready) else 1


if __name__ == "__main__":
    raise SystemExit(main())
