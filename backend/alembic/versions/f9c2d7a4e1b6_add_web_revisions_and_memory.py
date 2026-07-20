"""add website message revisions and user-scoped memory

Revision ID: f9c2d7a4e1b6
Revises: e2b7c4d9a1f3
"""

from alembic import op
import sqlalchemy as sa


revision = "f9c2d7a4e1b6"
down_revision = "e2b7c4d9a1f3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("web_chat_message") as batch:
        batch.add_column(sa.Column("replaces_message_id", sa.String(36), nullable=True))
        batch.add_column(sa.Column("revision_number", sa.Integer(), nullable=False, server_default="1"))
        batch.add_column(sa.Column("superseded_at", sa.DateTime(timezone=True), nullable=True))
        batch.create_index("ix_web_chat_message_replaces_message_id", ["replaces_message_id"])
        batch.create_index("ix_web_chat_message_superseded_at", ["superseded_at"])
        batch.create_foreign_key(
            "fk_web_chat_message_replaces_message", "web_chat_message",
            ["replaces_message_id"], ["id"], ondelete="SET NULL",
        )
    with op.batch_alter_table("web_usage_preferences") as batch:
        batch.add_column(sa.Column("memory_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))

    op.create_table(
        "web_memory_fact",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("normalized_key", sa.String(160), nullable=False),
        sa.Column("value_text", sa.Text(), nullable=False),
        sa.Column("category", sa.String(40), nullable=False, server_default="preference"),
        sa.Column("salience", sa.Float(), nullable=False, server_default="0.5"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column("source_thread_id", sa.String(36), nullable=True),
        sa.Column("source_message_id", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_thread_id"], ["web_chat_thread.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["source_message_id"], ["web_chat_message.id"], ondelete="SET NULL"),
        sa.UniqueConstraint("user_id", "normalized_key", name="uq_web_memory_fact_user_key"),
    )
    op.create_index("ix_web_memory_fact_user_id", "web_memory_fact", ["user_id"])
    op.create_index("ix_web_memory_fact_category", "web_memory_fact", ["category"])
    op.create_index("ix_web_memory_fact_source_thread_id", "web_memory_fact", ["source_thread_id"])
    op.create_index("ix_web_memory_fact_source_message_id", "web_memory_fact", ["source_message_id"])
    op.create_index("ix_web_memory_fact_updated_at", "web_memory_fact", ["updated_at"])
    op.create_index("ix_web_memory_fact_deleted_at", "web_memory_fact", ["deleted_at"])
    op.create_index("ix_web_memory_fact_user_updated", "web_memory_fact", ["user_id", "updated_at"])

    op.create_table(
        "web_conversation_summary",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("thread_id", sa.String(36), nullable=False),
        sa.Column("summary_text", sa.Text(), nullable=False),
        sa.Column("keywords_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["thread_id"], ["web_chat_thread.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", "thread_id", name="uq_web_conversation_summary_user_thread"),
    )
    op.create_index("ix_web_conversation_summary_user_id", "web_conversation_summary", ["user_id"])
    op.create_index("ix_web_conversation_summary_thread_id", "web_conversation_summary", ["thread_id"])
    op.create_index("ix_web_conversation_summary_updated_at", "web_conversation_summary", ["updated_at"])
    op.create_index("ix_web_conversation_summary_user_updated", "web_conversation_summary", ["user_id", "updated_at"])


def downgrade() -> None:
    op.drop_table("web_conversation_summary")
    op.drop_table("web_memory_fact")
    with op.batch_alter_table("web_usage_preferences") as batch:
        batch.drop_column("memory_enabled")
    with op.batch_alter_table("web_chat_message") as batch:
        batch.drop_constraint("fk_web_chat_message_replaces_message", type_="foreignkey")
        batch.drop_index("ix_web_chat_message_superseded_at")
        batch.drop_index("ix_web_chat_message_replaces_message_id")
        batch.drop_column("superseded_at")
        batch.drop_column("revision_number")
        batch.drop_column("replaces_message_id")
