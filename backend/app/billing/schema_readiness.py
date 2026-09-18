"""Read-only checks for billing maintenance's current database contract."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import inspect
from sqlalchemy.exc import SQLAlchemyError


class BillingSchemaNotReady(RuntimeError):
    """The API-owned migration has not made the current billing schema ready."""


@dataclass(frozen=True)
class BillingSchemaReadiness:
    required_tables: tuple[str, ...]
    missing_tables: tuple[str, ...]
    missing_columns: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return not self.missing_tables and not self.missing_columns


_REQUIRED_COLUMNS = {
    "video_job": ("payment_id", "state", "fence", "deadline"),
    "video_outbox": ("kind", "state", "due_at"),
    "usage_charge": ("tester_credit_window_id",),
    "weekly_tester_credit_window": (
        "id", "user_id", "credit_bucket", "period_start", "period_end",
        "allowance_micros", "reserved_micros", "consumed_micros", "version",
    ),
}


def inspect_billing_schema(engine: Any) -> BillingSchemaReadiness:
    """Inspect required billing tables/columns without issuing any writes."""
    required_tables = tuple(_REQUIRED_COLUMNS)
    try:
        with engine.connect() as connection:
            inspector = inspect(connection)
            missing_tables = tuple(
                table for table in required_tables if not inspector.has_table(table)
            )
            missing_columns: list[str] = []
            for table, columns in _REQUIRED_COLUMNS.items():
                if table in missing_tables:
                    continue
                present = {str(item["name"]) for item in inspector.get_columns(table)}
                missing_columns.extend(
                    f"{table}.{column}" for column in columns if column not in present
                )
    except SQLAlchemyError:
        raise BillingSchemaNotReady(
            "Billing database schema could not be verified; the backend pre-deploy "
            "migration must run before financial maintenance."
        ) from None
    return BillingSchemaReadiness(
        required_tables=required_tables,
        missing_tables=missing_tables,
        missing_columns=tuple(missing_columns),
    )


def require_billing_schema(engine: Any) -> BillingSchemaReadiness:
    readiness = inspect_billing_schema(engine)
    if readiness.ready:
        return readiness
    missing = [*readiness.missing_tables, *readiness.missing_columns]
    raise BillingSchemaNotReady(
        "Billing database schema is behind the application (missing "
        + ", ".join(missing)
        + "); the backend pre-deploy Alembic migration must run first."
    )
