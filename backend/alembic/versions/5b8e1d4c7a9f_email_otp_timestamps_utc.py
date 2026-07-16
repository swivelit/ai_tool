"""store email OTP timestamps as timezone-aware UTC

Revision ID: 5b8e1d4c7a9f
Revises: 6d4f2a9c8b71
Create Date: 2026-07-16 00:00:00.000000

Existing TIMESTAMP WITHOUT TIME ZONE values are explicitly interpreted as UTC.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "5b8e1d4c7a9f"
down_revision: Union[str, Sequence[str], None] = "6d4f2a9c8b71"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TIMESTAMP_COLUMNS = (
    ("created_at", False),
    ("expires_at", False),
    ("consumed_at", True),
    ("last_sent_at", False),
)


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        # SQLite has no distinct timezone-aware datetime storage class. The
        # application boundary normalizes its naive round-trip values to UTC.
        return

    for column_name, nullable in _TIMESTAMP_COLUMNS:
        op.alter_column(
            "email_otp_code",
            column_name,
            existing_type=sa.DateTime(timezone=False),
            type_=sa.DateTime(timezone=True),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'UTC'",
        )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    for column_name, nullable in _TIMESTAMP_COLUMNS:
        op.alter_column(
            "email_otp_code",
            column_name,
            existing_type=sa.DateTime(timezone=True),
            type_=sa.DateTime(timezone=False),
            existing_nullable=nullable,
            postgresql_using=f"{column_name} AT TIME ZONE 'UTC'",
        )
