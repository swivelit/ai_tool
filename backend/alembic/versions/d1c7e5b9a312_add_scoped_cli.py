"""add scoped Swico CLI device sessions and agent state

Revision ID: d1c7e5b9a312
Revises: 7a065149f040
"""

from alembic import op
import sqlalchemy as sa


revision = "d1c7e5b9a312"
down_revision = "7a065149f040"
branch_labels = None
depends_on = None


def _timestamps(table):
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "cli_device_grant",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("device_code_digest", sa.String(64), nullable=False),
        sa.Column("user_code_digest", sa.String(64), nullable=False),
        sa.Column("code_challenge", sa.String(128), nullable=False),
        sa.Column("device_description", sa.String(120), nullable=False),
        sa.Column("scopes_json", sa.Text(), nullable=False, server_default='["chat"]'),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("approved_user_id", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("interval_seconds", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("poll_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("user_attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_poll_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_user_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["approved_user_id"], ["user.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("device_code_digest", name="uq_cli_device_grant_device_digest"),
        sa.UniqueConstraint("user_code_digest", name="uq_cli_device_grant_user_digest"),
        sa.CheckConstraint("status IN ('pending', 'approved', 'denied', 'consumed', 'expired')", name="ck_cli_device_grant_status"),
        sa.CheckConstraint("poll_count >= 0 AND user_attempt_count >= 0", name="ck_cli_device_grant_attempts"),
    )
    op.create_index("ix_cli_device_grant_status_expires", "cli_device_grant", ["status", "expires_at"])
    op.create_index("ix_cli_device_grant_approved_user_id", "cli_device_grant", ["approved_user_id"])
    op.create_index("ix_cli_device_grant_created_at", "cli_device_grant", ["created_at"])
    op.create_index("ix_cli_device_grant_last_poll_at", "cli_device_grant", ["last_poll_at"])
    op.create_index("ix_cli_device_grant_last_user_attempt_at", "cli_device_grant", ["last_user_attempt_at"])
    op.create_index("ix_cli_device_grant_consumed_at", "cli_device_grant", ["consumed_at"])
    op.create_index("ix_cli_device_grant_device_code_digest", "cli_device_grant", ["device_code_digest"])
    op.create_index("ix_cli_device_grant_user_code_digest", "cli_device_grant", ["user_code_digest"])

    op.create_table(
        "cli_session",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("access_token_digest", sa.String(64), nullable=False),
        sa.Column("access_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("refresh_token_digest", sa.String(64), nullable=False),
        sa.Column("previous_refresh_token_digest", sa.String(64), nullable=True),
        sa.Column("refresh_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("max_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("selected_tier", sa.String(16), nullable=False),
        sa.Column("scopes_json", sa.Text(), nullable=False, server_default='["chat"]'),
        sa.Column("device_description", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoke_reason", sa.String(64), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("access_token_digest", name="uq_cli_session_access_digest"),
        sa.UniqueConstraint("refresh_token_digest", name="uq_cli_session_refresh_digest"),
    )
    op.create_index("ix_cli_session_user_active", "cli_session", ["user_id", "revoked_at", "refresh_expires_at"])
    for col in ("user_id", "access_token_digest", "access_expires_at", "refresh_token_digest", "previous_refresh_token_digest", "refresh_expires_at", "max_expires_at", "selected_tier", "created_at", "last_seen_at", "revoked_at"):
        op.create_index(f"ix_cli_session_{col}", "cli_session", [col])

    op.create_table(
        "cli_agent_run",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("thread_id", sa.String(36), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("tier", sa.String(16), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="created"),
        sa.Column("max_steps", sa.Integer(), nullable=False, server_default="8"),
        sa.Column("current_step", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("task_hash", sa.String(64), nullable=False),
        sa.Column("terminal_reason", sa.String(128), nullable=True),
        sa.Column("cancellation_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["thread_id"], ["web_chat_thread.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("request_id", name="uq_cli_agent_run_request_id"),
        sa.CheckConstraint("status IN ('created', 'running', 'waiting_approval', 'completed', 'cancelled', 'failed', 'expired')", name="ck_cli_agent_run_status"),
        sa.CheckConstraint("max_steps > 0 AND current_step >= 0", name="ck_cli_agent_run_steps"),
    )
    op.create_index("ix_cli_agent_run_user_status", "cli_agent_run", ["user_id", "status", "updated_at"])
    for col in ("user_id", "thread_id", "request_id", "tier", "status", "created_at", "updated_at", "expires_at"):
        op.create_index(f"ix_cli_agent_run_{col}", "cli_agent_run", [col])

    op.create_table(
        "cli_agent_step",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("action_id", sa.String(64), nullable=False),
        sa.Column("action_type", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("result_hash", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["cli_agent_run.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("run_id", "sequence", name="uq_cli_agent_step_run_sequence"),
        sa.UniqueConstraint("run_id", "action_id", name="uq_cli_agent_step_run_action"),
        sa.CheckConstraint("status IN ('pending', 'approved', 'executing', 'succeeded', 'failed', 'unknown', 'expired')", name="ck_cli_agent_step_status"),
    )
    op.create_index("ix_cli_agent_step_run_status", "cli_agent_step", ["run_id", "status"])
    for col in ("run_id", "status", "created_at", "updated_at"):
        op.create_index(f"ix_cli_agent_step_{col}", "cli_agent_step", [col])

    op.create_table(
        "cli_pending_action",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False),
        sa.Column("action_id", sa.String(64), nullable=False),
        sa.Column("action_type", sa.String(32), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["run_id"], ["cli_agent_run.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("action_id", name="uq_cli_pending_action_id"),
        sa.CheckConstraint("status IN ('pending', 'approved', 'submitted', 'expired', 'rejected')", name="ck_cli_pending_action_status"),
    )
    op.create_index("ix_cli_pending_action_run_status", "cli_pending_action", ["run_id", "status", "expires_at"])
    for col in ("run_id", "action_id", "status", "expires_at", "created_at", "resolved_at"):
        op.create_index(f"ix_cli_pending_action_{col}", "cli_pending_action", [col])


def downgrade() -> None:
    for name, table in (("cli_pending_action", "cli_pending_action"), ("cli_agent_step", "cli_agent_step"), ("cli_agent_run", "cli_agent_run"), ("cli_session", "cli_session"), ("cli_device_grant", "cli_device_grant")):
        inspector = sa.inspect(op.get_bind())
        for index in list(inspector.get_indexes(table)):
            if index.get("name"):
                op.drop_index(index["name"], table_name=table)
        op.drop_table(name)
