from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import json
import os
import sys
from uuid import UUID

from app.database_url import (
    database_url_scheme,
    is_postgres_database_url,
    is_sqlite_database_url,
    normalize_database_url,
)


CONFIGURATION_ERROR_EXIT_CODE = 78
FINDINGS_EXIT_CODE = 3
_LOCAL_SQLITE_ENVIRONMENTS = {"test", "development"}


class MaintenanceConfigurationError(RuntimeError):
    """Configuration failure whose message contains names, never values."""


@dataclass(frozen=True, repr=False)
class MaintenanceDatabaseConfiguration:
    url: str
    backend: str
    app_env: str


@dataclass(frozen=True, repr=False)
class RazorpayConfiguration:
    mode: str
    key_id: str
    key_secret: str


def _value(environ: Mapping[str, str], name: str) -> str:
    return str(environ.get(name, "") or "").strip()


def validate_maintenance_database(
    environ: Mapping[str, str] | None = None,
) -> MaintenanceDatabaseConfiguration:
    env = os.environ if environ is None else environ
    raw_url = _value(env, "DATABASE_URL")
    app_env = _value(env, "APP_ENV").lower()

    if not raw_url:
        raise MaintenanceConfigurationError(
            "DATABASE_URL must be explicitly configured for billing maintenance "
            "and normally use PostgreSQL"
        )

    if is_postgres_database_url(raw_url):
        return MaintenanceDatabaseConfiguration(
            url=normalize_database_url(raw_url),
            backend="postgresql",
            app_env=app_env or "unset",
        )

    if is_sqlite_database_url(raw_url):
        if app_env in {"prod", "production"}:
            raise MaintenanceConfigurationError(
                "DATABASE_URL must use PostgreSQL when APP_ENV is prod or production; "
                "BILLING_MAINTENANCE_ALLOW_SQLITE cannot override production"
            )
        allow_sqlite = _value(env, "BILLING_MAINTENANCE_ALLOW_SQLITE").lower() == "true"
        if app_env not in _LOCAL_SQLITE_ENVIRONMENTS or not allow_sqlite:
            raise MaintenanceConfigurationError(
                "DATABASE_URL must use PostgreSQL for billing maintenance; SQLite requires "
                "APP_ENV=test or APP_ENV=development and "
                "BILLING_MAINTENANCE_ALLOW_SQLITE=true"
            )
        return MaintenanceDatabaseConfiguration(
            url=normalize_database_url(raw_url),
            backend="sqlite",
            app_env=app_env,
        )

    scheme = database_url_scheme(raw_url)
    if not scheme:
        raise MaintenanceConfigurationError(
            "DATABASE_URL must be a database URL using a supported PostgreSQL scheme"
        )
    raise MaintenanceConfigurationError(
        "DATABASE_URL must use postgres://, postgresql://, "
        "postgresql+psycopg://, or postgresql+psycopg2://"
    )


def validate_razorpay_configuration(
    environ: Mapping[str, str] | None = None,
) -> RazorpayConfiguration:
    env = os.environ if environ is None else environ
    mode = _value(env, "RAZORPAY_MODE").lower()
    key_id = _value(env, "RAZORPAY_KEY_ID")
    key_secret = _value(env, "RAZORPAY_KEY_SECRET")
    errors: list[str] = []

    if mode not in {"test", "live"}:
        errors.append("RAZORPAY_MODE must be explicitly set to test or live")
    if not key_id:
        errors.append("RAZORPAY_KEY_ID must be configured")
    elif mode == "test" and not key_id.startswith("rzp_test_"):
        errors.append("RAZORPAY_KEY_ID must use the rzp_test_ prefix when RAZORPAY_MODE=test")
    elif mode == "live" and not key_id.startswith("rzp_live_"):
        errors.append("RAZORPAY_KEY_ID must use the rzp_live_ prefix when RAZORPAY_MODE=live")
    if not key_secret:
        errors.append("RAZORPAY_KEY_SECRET must be configured")

    if errors:
        raise MaintenanceConfigurationError("; ".join(errors))
    return RazorpayConfiguration(mode=mode, key_id=key_id, key_secret=key_secret)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Internal Swico billing maintenance")
    sub = parser.add_subparsers(dest="command", required=True)
    stale = sub.add_parser("stale-reservations")
    stale.add_argument(
        "--age-seconds",
        type=int,
        default=int(os.getenv("BILLING_STALE_RESERVATION_AGE_SECONDS", "1800")),
    )
    razorpay = sub.add_parser("razorpay")
    razorpay.add_argument("--age-seconds", type=int, default=900)
    razorpay.add_argument("--internal-order-id")
    razorpay.add_argument("--apply", action="store_true")
    razorpay.add_argument("--summary-only", action="store_true")
    razorpay.add_argument("--fail-on-findings", action="store_true")
    audit = sub.add_parser("audit")
    audit.add_argument("--captured-uncredited-age-seconds", type=int, default=900)
    audit.add_argument(
        "--stale-reservation-age-seconds",
        type=int,
        default=int(os.getenv("BILLING_STALE_RESERVATION_AGE_SECONDS", "1800")),
    )
    audit.add_argument("--fail-on-findings", action="store_true")
    return parser


def _startup_record(
    args: argparse.Namespace,
    database: MaintenanceDatabaseConfiguration,
    razorpay: RazorpayConfiguration | None,
) -> None:
    record: dict[str, object] = {
        "command": args.command,
        "database_backend": database.backend,
        "APP_ENV": database.app_env,
    }
    if args.command == "razorpay":
        record["apply"] = bool(args.apply)
        record["summary_only"] = bool(args.summary_only)
        record["razorpay_mode"] = razorpay.mode if razorpay is not None else "unavailable"
        if args.fail_on_findings:
            record["fail_on_findings"] = True
    if args.command == "audit":
        record["fail_on_findings"] = bool(args.fail_on_findings)
    print(json.dumps(record, sort_keys=True), file=sys.stderr)


def _run_command(
    args: argparse.Namespace,
    razorpay: RazorpayConfiguration | None,
) -> bool:
    # This import is intentionally after maintenance-specific validation. It is
    # the boundary that may construct an SQLAlchemy engine.
    from app.database import SessionLocal

    session = SessionLocal()
    try:
        if args.command == "stale-reservations":
            from app.billing.service import recover_stale_usage_reservations

            recovered = recover_stale_usage_reservations(
                session, age_seconds=args.age_seconds
            )
            session.commit()
            print(json.dumps({"recovered_count": len(recovered)}))
            return False

        if args.command == "audit":
            from app.billing.audit import financial_audit
            from app.observability import add_sentry_context, bootstrap_observability, capture_exception

            report = financial_audit(
                session,
                captured_uncredited_age_seconds=args.captured_uncredited_age_seconds,
                stale_reservation_age_seconds=args.stale_reservation_age_seconds,
            )
            session.rollback()
            print(json.dumps(report, default=str, sort_keys=True))
            if int(report["actionable_finding_count"]) and os.getenv("SENTRY_DSN", "").strip():
                bootstrap_observability()
                safe_counts = {item["category"]: item["count"] for item in report["findings"]}
                add_sentry_context("financial_audit", {"counts": safe_counts})
                capture_exception(RuntimeError(
                    f"financial audit found {report['actionable_finding_count']} actionable high-severity item(s)"
                ))
            return bool(report["actionable_finding_count"])

        from app.billing.razorpay_client import RazorpayClient
        from app.billing.reconciliation import reconciliation_summary, reconcile_razorpay_orders

        if razorpay is None:  # Defensive: main always validates this command.
            raise MaintenanceConfigurationError(
                "RAZORPAY_MODE, RAZORPAY_KEY_ID, and RAZORPAY_KEY_SECRET must be configured"
            )
        results = reconcile_razorpay_orders(
            session,
            client=RazorpayClient(
                key_id=razorpay.key_id,
                key_secret=razorpay.key_secret,
            ),
            age_seconds=args.age_seconds,
            apply=args.apply,
            internal_order_id=args.internal_order_id,
        )
        if args.summary_only:
            print(json.dumps({"apply": args.apply, "summary": reconciliation_summary(results)}, default=str, sort_keys=True))
        else:
            print(json.dumps({"apply": args.apply, "results": results}, default=str))
        if not args.apply:
            session.rollback()
        return any(
            item.get("severity") == "high" and item.get("actionable") is True
            for item in results
        )
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "razorpay" and args.internal_order_id:
            try:
                args.internal_order_id = str(UUID(args.internal_order_id))
            except (TypeError, ValueError, AttributeError) as exc:
                raise MaintenanceConfigurationError(
                    "--internal-order-id must be a valid UUID"
                ) from exc
        database = validate_maintenance_database()
        razorpay = (
            validate_razorpay_configuration() if args.command == "razorpay" else None
        )
    except MaintenanceConfigurationError as exc:
        print(f"billing maintenance configuration error: {exc}", file=sys.stderr)
        return CONFIGURATION_ERROR_EXIT_CODE

    # Keep app.database consistent if a PostgreSQL alias was normalized.
    os.environ["DATABASE_URL"] = database.url
    _startup_record(args, database, razorpay)
    has_findings = _run_command(args, razorpay)
    if bool(getattr(args, "fail_on_findings", False)) and has_findings:
        return FINDINGS_EXIT_CODE
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
