"""add web usage preferences and period serialization rows

Revision ID: 8c1f4e7b2a90
Revises: 5b8e1d4c7a9f
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "8c1f4e7b2a90"
down_revision: Union[str, Sequence[str], None] = "5b8e1d4c7a9f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "web_usage_preferences",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period", sa.String(16), nullable=False, server_default="monthly"),
        sa.Column("hard_limit_micros", sa.BigInteger(), nullable=True),
        sa.Column("warning_threshold_percent", sa.Integer(), nullable=False, server_default="80"),
        sa.Column("notify_at_threshold", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", name="uq_web_usage_preferences_user_id"),
        sa.CheckConstraint("period = 'monthly'", name="ck_web_usage_preferences_period"),
        sa.CheckConstraint("hard_limit_micros IS NULL OR hard_limit_micros > 0", name="ck_web_usage_preferences_hard_limit"),
        sa.CheckConstraint("warning_threshold_percent BETWEEN 1 AND 100", name="ck_web_usage_preferences_warning"),
    )
    op.create_index("ix_web_usage_preferences_user_id", "web_usage_preferences", ["user_id"])
    op.create_index("ix_web_usage_preferences_updated_at", "web_usage_preferences", ["updated_at"])

    op.create_table(
        "web_usage_period_lock",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period_start_utc", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "period_start_utc", name="uq_web_usage_period_lock_user_start"),
    )
    op.create_index("ix_web_usage_period_lock_user_id", "web_usage_period_lock", ["user_id"])
    op.create_index("ix_web_usage_period_lock_period_start_utc", "web_usage_period_lock", ["period_start_utc"])
    op.create_index("ix_web_usage_period_lock_updated_at", "web_usage_period_lock", ["updated_at"])


def downgrade() -> None:
    op.drop_table("web_usage_period_lock")
    op.drop_table("web_usage_preferences")
