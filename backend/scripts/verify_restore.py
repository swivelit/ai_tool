from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sys

from app.database_url import is_postgres_database_url, normalize_database_url


CONFIGURATION_ERROR_EXIT_CODE = 78
INVARIANT_FAILURE_EXIT_CODE = 4
REQUIRED_TABLES = {
    "alembic_version", "user", "wallet_account", "wallet_ledger",
    "payment_order", "processed_webhook", "usage_charge", "web_chat_thread",
    "web_chat_message", "web_usage_preferences",
}


class RestoreConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True, repr=False)
class RestoreConfiguration:
    database_url: str
    app_env: str


def validate_restore_environment(environ: Mapping[str, str] | None = None) -> RestoreConfiguration:
    env = os.environ if environ is None else environ
    app_env = str(env.get("APP_ENV", "") or "").strip().lower()
    confirmation = str(env.get("RESTORE_DRILL_CONFIRMATION", "") or "").strip().lower()
    database_url = str(env.get("DATABASE_URL", "") or "").strip()
    if app_env in {"prod", "production"}:
        raise RestoreConfigurationError("APP_ENV=production is always refused")
    if app_env not in {"staging", "test"}:
        raise RestoreConfigurationError("APP_ENV must be staging or test")
    if confirmation != "disposable":
        raise RestoreConfigurationError("RESTORE_DRILL_CONFIRMATION must equal disposable")
    if not database_url or not is_postgres_database_url(database_url):
        raise RestoreConfigurationError("DATABASE_URL must be an explicit PostgreSQL restore URL")
    return RestoreConfiguration(normalize_database_url(database_url), app_env)


def _scalar(connection, statement: str) -> int:
    from sqlalchemy import text

    return int(connection.execute(text(statement)).scalar_one())


def verify_restore(configuration: RestoreConfiguration) -> dict[str, object]:
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from sqlalchemy import create_engine, inspect, text

    backend_root = Path(__file__).resolve().parents[1]
    alembic_config = Config(str(backend_root / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(backend_root / "alembic"))
    heads = ScriptDirectory.from_config(alembic_config).get_heads()
    failures: list[str] = []
    if len(heads) != 1:
        failures.append("repository must have exactly one Alembic head")

    engine = create_engine(configuration.database_url, pool_pre_ping=True)
    try:
        with engine.connect() as connection:
            transaction = connection.begin()
            try:
                connection.execute(text("SET TRANSACTION READ ONLY"))
                table_names = set(inspect(connection).get_table_names())
                missing = sorted(REQUIRED_TABLES - table_names)
                if missing:
                    failures.append("missing required tables: " + ", ".join(missing))
                database_heads = sorted(
                    str(row[0]) for row in connection.execute(text("SELECT version_num FROM alembic_version"))
                ) if "alembic_version" in table_names else []
                if sorted(heads) != database_heads:
                    failures.append("restored database is not at the current Alembic head")

                row_counts = {
                    table: _scalar(connection, f'SELECT COUNT(*) FROM "{table}"')
                    for table in sorted(REQUIRED_TABLES - {"alembic_version"}) if table in table_names
                }
                checks: dict[str, int] = {}
                if {"wallet_account", "wallet_ledger", "payment_order", "usage_charge"}.issubset(table_names):
                    checks.update({
                        "negative_wallet_balance": _scalar(connection, "SELECT COUNT(*) FROM wallet_account WHERE balance_micros < 0"),
                        "negative_wallet_reservation": _scalar(connection, "SELECT COUNT(*) FROM wallet_account WHERE reserved_micros < 0"),
                        "reservation_exceeds_balance": _scalar(connection, "SELECT COUNT(*) FROM wallet_account WHERE reserved_micros > balance_micros"),
                        "duplicate_payment_ids": _scalar(connection, "SELECT COUNT(*) FROM (SELECT provider_payment_id FROM payment_order WHERE provider_payment_id IS NOT NULL GROUP BY provider_payment_id HAVING COUNT(*) > 1) duplicates"),
                        "duplicate_ledger_idempotency": _scalar(connection, "SELECT COUNT(*) FROM (SELECT idempotency_key FROM wallet_ledger GROUP BY idempotency_key HAVING COUNT(*) > 1) duplicates"),
                        "duplicate_usage_requests": _scalar(connection, "SELECT COUNT(*) FROM (SELECT request_id FROM usage_charge GROUP BY request_id HAVING COUNT(*) > 1) duplicates"),
                        "orphan_wallet_users": _scalar(connection, 'SELECT COUNT(*) FROM wallet_account child LEFT JOIN "user" parent ON parent.id=child.user_id WHERE parent.id IS NULL'),
                        "orphan_ledger_users": _scalar(connection, 'SELECT COUNT(*) FROM wallet_ledger child LEFT JOIN "user" parent ON parent.id=child.user_id WHERE parent.id IS NULL'),
                        "orphan_payment_users": _scalar(connection, 'SELECT COUNT(*) FROM payment_order child LEFT JOIN "user" parent ON parent.id=child.user_id WHERE parent.id IS NULL'),
                        "orphan_usage_users": _scalar(connection, 'SELECT COUNT(*) FROM usage_charge child LEFT JOIN "user" parent ON parent.id=child.user_id WHERE parent.id IS NULL'),
                    })
                if {"web_chat_message", "web_chat_thread"}.issubset(table_names):
                    checks["orphan_chat_threads"] = _scalar(connection, "SELECT COUNT(*) FROM web_chat_message child LEFT JOIN web_chat_thread parent ON parent.id=child.thread_id WHERE parent.id IS NULL")
                for name, count in checks.items():
                    if count:
                        failures.append(f"{name}: {count}")
                report: dict[str, object] = {
                    "app_env": configuration.app_env,
                    "database_backend": "postgresql",
                    "read_only": True,
                    "repository_alembic_heads": heads,
                    "database_alembic_heads": database_heads,
                    "row_counts": row_counts,
                    "invariant_counts": checks,
                    "failures": failures,
                }
            finally:
                transaction.rollback()
    finally:
        engine.dispose()
    return report


def main(argv: Sequence[str] | None = None) -> int:
    del argv
    try:
        configuration = validate_restore_environment()
    except RestoreConfigurationError as exc:
        print(f"restore verification configuration error: {exc}", file=sys.stderr)
        return CONFIGURATION_ERROR_EXIT_CODE
    try:
        report = verify_restore(configuration)
    except Exception as exc:
        print(f"restore verification failed safely: {type(exc).__name__}", file=sys.stderr)
        return INVARIANT_FAILURE_EXIT_CODE
    print(json.dumps(report, sort_keys=True))
    return INVARIANT_FAILURE_EXIT_CODE if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
