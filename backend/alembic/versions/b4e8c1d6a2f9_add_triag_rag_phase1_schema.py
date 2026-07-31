"""add TRIAG-RAG Phase 1 safe telemetry schema

Revision ID: b4e8c1d6a2f9
Revises: 3a7d9c2e5f10
"""

from alembic import op
import sqlalchemy as sa


revision = "b4e8c1d6a2f9"
down_revision = "3a7d9c2e5f10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "web_retrieval_trace",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("thread_id", sa.String(36), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("policy_version", sa.String(24), nullable=False),
        sa.Column("tier_id", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="planned"),
        sa.Column("safe_metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('planned', 'running', 'complete', 'skipped', 'failed')",
            name="ck_web_retrieval_trace_status",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["thread_id"], ["web_chat_thread.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_web_retrieval_trace_user_idempotency",
        ),
    )
    op.create_index(
        "ix_web_retrieval_trace_user_id",
        "web_retrieval_trace",
        ["user_id"],
    )
    op.create_index(
        "ix_web_retrieval_trace_thread_id",
        "web_retrieval_trace",
        ["thread_id"],
    )
    op.create_index(
        "ix_web_retrieval_trace_request_id",
        "web_retrieval_trace",
        ["request_id"],
    )
    op.create_index(
        "ix_web_retrieval_trace_status",
        "web_retrieval_trace",
        ["status"],
    )
    op.create_index(
        "ix_web_retrieval_trace_created_at",
        "web_retrieval_trace",
        ["created_at"],
    )
    op.create_index(
        "ix_web_retrieval_trace_updated_at",
        "web_retrieval_trace",
        ["updated_at"],
    )
    op.create_index(
        "ix_web_retrieval_trace_user_request",
        "web_retrieval_trace",
        ["user_id", "request_id"],
    )

    op.create_table(
        "web_evidence_item",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("trace_id", sa.String(36), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("source_type", sa.String(32), nullable=False),
        sa.Column("source_id", sa.String(160), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("estimated_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="candidate"),
        sa.Column("safe_metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('candidate', 'selected', 'rejected', 'consumed')",
            name="ck_web_evidence_item_status",
        ),
        sa.ForeignKeyConstraint(
            ["trace_id"], ["web_retrieval_trace.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_web_evidence_item_user_idempotency",
        ),
        sa.UniqueConstraint(
            "trace_id",
            "ordinal",
            name="uq_web_evidence_item_trace_ordinal",
        ),
    )
    for name in (
        "trace_id",
        "user_id",
        "request_id",
        "source_type",
        "status",
        "created_at",
    ):
        op.create_index(
            f"ix_web_evidence_item_{name}",
            "web_evidence_item",
            [name],
        )
    op.create_index(
        "ix_web_evidence_item_user_request",
        "web_evidence_item",
        ["user_id", "request_id"],
    )

    op.create_table(
        "web_answer_check",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("thread_id", sa.String(36), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("assistant_message_id", sa.String(36), nullable=True),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="not_run"),
        sa.Column("passed", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("safe_metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('not_run', 'passed', 'failed', 'skipped', 'error')",
            name="ck_web_answer_check_status",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["thread_id"], ["web_chat_thread.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["assistant_message_id"],
            ["web_chat_message.id"],
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_web_answer_check_user_idempotency",
        ),
    )
    for name in (
        "user_id",
        "thread_id",
        "request_id",
        "assistant_message_id",
        "status",
        "created_at",
        "updated_at",
    ):
        op.create_index(
            f"ix_web_answer_check_{name}",
            "web_answer_check",
            [name],
        )
    op.create_index(
        "ix_web_answer_check_user_request",
        "web_answer_check",
        ["user_id", "request_id"],
    )

    op.create_table(
        "web_usage_stage",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("thread_id", sa.String(36), nullable=True),
        sa.Column("usage_charge_id", sa.String(36), nullable=True),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("stage_name", sa.String(32), nullable=False),
        sa.Column("stage_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="planned"),
        sa.Column("reserved_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("debited_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("safe_metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('planned', 'reserved', 'running', 'settled', 'released', 'skipped', 'failed')",
            name="ck_web_usage_stage_status",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["thread_id"], ["web_chat_thread.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["usage_charge_id"], ["usage_charge.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_web_usage_stage_user_idempotency",
        ),
        sa.UniqueConstraint(
            "user_id",
            "request_id",
            "stage_name",
            name="uq_web_usage_stage_user_request_stage",
        ),
    )
    for name in (
        "user_id",
        "thread_id",
        "usage_charge_id",
        "request_id",
        "stage_name",
        "status",
        "created_at",
        "updated_at",
    ):
        op.create_index(
            f"ix_web_usage_stage_{name}",
            "web_usage_stage",
            [name],
        )
    op.create_index(
        "ix_web_usage_stage_user_request",
        "web_usage_stage",
        ["user_id", "request_id"],
    )


def downgrade() -> None:
    op.drop_table("web_usage_stage")
    op.drop_table("web_answer_check")
    op.drop_table("web_evidence_item")
    op.drop_table("web_retrieval_trace")
