"""add bounded owner-scoped cloud review artifacts"""

from alembic import op
import sqlalchemy as sa

revision = "20260917_cli_cloud_artifacts"
down_revision = "20260916_cli_cloud_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cli_cloud_artifact",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("job_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=False, server_default="application/octet-stream"),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["cli_cloud_job.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "attempt", "kind", name="uq_cli_cloud_artifact_attempt_kind"),
    )
    op.create_index("ix_cli_cloud_artifact_job_id", "cli_cloud_artifact", ["job_id"])
    op.create_index("ix_cli_cloud_artifact_user_id", "cli_cloud_artifact", ["user_id"])
    op.create_index("ix_cli_cloud_artifact_job_created", "cli_cloud_artifact", ["job_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_cli_cloud_artifact_job_created", table_name="cli_cloud_artifact")
    op.drop_index("ix_cli_cloud_artifact_user_id", table_name="cli_cloud_artifact")
    op.drop_index("ix_cli_cloud_artifact_job_id", table_name="cli_cloud_artifact")
    op.drop_table("cli_cloud_artifact")
