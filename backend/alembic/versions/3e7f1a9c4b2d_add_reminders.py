"""add user reminders

Revision ID: 3e7f1a9c4b2d
Revises: 1f2e3d4c5b6a
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "3e7f1a9c4b2d"
down_revision: Union[str, Sequence[str], None] = "1f2e3d4c5b6a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "reminder",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("job.id", ondelete="SET NULL"), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_reminder_user_id", "reminder", ["user_id"])
    op.create_index("ix_reminder_scheduled_at", "reminder", ["scheduled_at"])
    op.create_index("ix_reminder_status", "reminder", ["status"])
    op.create_index("ix_reminder_job_id", "reminder", ["job_id"])
    op.create_index(
        "ix_reminder_user_status_scheduled",
        "reminder",
        ["user_id", "status", "scheduled_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_reminder_user_status_scheduled", table_name="reminder")
    op.drop_index("ix_reminder_job_id", table_name="reminder")
    op.drop_index("ix_reminder_status", table_name="reminder")
    op.drop_index("ix_reminder_scheduled_at", table_name="reminder")
    op.drop_index("ix_reminder_user_id", table_name="reminder")
    op.drop_table("reminder")
