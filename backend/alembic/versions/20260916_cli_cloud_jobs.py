"""add durable Swico cloud control-plane jobs and events"""

from alembic import op
import sqlalchemy as sa


revision = "20260916_cli_cloud_jobs"
down_revision = "20260915_weekly_tester_credit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cli_cloud_job",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.String(length=64), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False, server_default="workspace_snapshot"),
        sa.Column("tier", sa.String(length=16), nullable=False),
        sa.Column("task", sa.Text(), nullable=False),
        sa.Column("task_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="queued"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("runner_id", sa.String(length=128), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reservation_id", sa.String(length=64), nullable=True),
        sa.Column("snapshot_metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("result_metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("failure_code", sa.String(length=64), nullable=True),
        sa.CheckConstraint(
            "status IN ('queued', 'dispatching', 'starting', 'running', 'waiting_for_approval', 'cancelling', 'completed', 'failed', 'cancelled', 'expired')",
            name="ck_cli_cloud_job_status",
        ),
        sa.CheckConstraint("attempt >= 0", name="ck_cli_cloud_job_attempt"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "request_id", name="uq_cli_cloud_job_user_request"),
    )
    op.create_index("ix_cli_cloud_job_user_id", "cli_cloud_job", ["user_id"])
    op.create_index("ix_cli_cloud_job_request_id", "cli_cloud_job", ["request_id"])
    op.create_index("ix_cli_cloud_job_status", "cli_cloud_job", ["status"])
    op.create_index("ix_cli_cloud_job_expires_at", "cli_cloud_job", ["expires_at"])
    op.create_index("ix_cli_cloud_job_lease_expires_at", "cli_cloud_job", ["lease_expires_at"])
    op.create_index("ix_cli_cloud_job_user_status", "cli_cloud_job", ["user_id", "status", "created_at"])

    op.create_table(
        "cli_cloud_job_event",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("job_id", sa.String(length=36), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=32), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["cli_cloud_job.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "sequence", name="uq_cli_cloud_job_event_sequence"),
    )
    op.create_index("ix_cli_cloud_job_event_job_id", "cli_cloud_job_event", ["job_id"])
    op.create_index("ix_cli_cloud_job_event_job_created", "cli_cloud_job_event", ["job_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_cli_cloud_job_event_job_created", table_name="cli_cloud_job_event")
    op.drop_index("ix_cli_cloud_job_event_job_id", table_name="cli_cloud_job_event")
    op.drop_table("cli_cloud_job_event")
    op.drop_index("ix_cli_cloud_job_user_status", table_name="cli_cloud_job")
    op.drop_index("ix_cli_cloud_job_lease_expires_at", table_name="cli_cloud_job")
    op.drop_index("ix_cli_cloud_job_expires_at", table_name="cli_cloud_job")
    op.drop_index("ix_cli_cloud_job_status", table_name="cli_cloud_job")
    op.drop_index("ix_cli_cloud_job_request_id", table_name="cli_cloud_job")
    op.drop_index("ix_cli_cloud_job_user_id", table_name="cli_cloud_job")
    op.drop_table("cli_cloud_job")
