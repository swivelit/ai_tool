"""add web feedback and memory fact embeddings

Revision ID: 3a7d9c2e5f10
Revises: f9c2d7a4e1b6
"""

from alembic import op
import sqlalchemy as sa


revision = "3a7d9c2e5f10"
down_revision = "f9c2d7a4e1b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("web_memory_fact") as batch:
        batch.add_column(sa.Column("embedding_json", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column("embedding_norm", sa.Float(), nullable=False, server_default="0")
        )
        batch.add_column(
            sa.Column(
                "accessed_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            )
        )
        batch.create_index("ix_web_memory_fact_accessed_at", ["accessed_at"])

    op.create_table(
        "web_message_feedback",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("message_id", sa.String(36), nullable=False),
        sa.Column("rating", sa.String(8), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["message_id"], ["web_chat_message.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "user_id", "message_id", name="uq_web_message_feedback_user_message"
        ),
    )
    op.create_index(
        "ix_web_message_feedback_user_id", "web_message_feedback", ["user_id"]
    )
    op.create_index(
        "ix_web_message_feedback_message_id",
        "web_message_feedback",
        ["message_id"],
    )
    op.create_index(
        "ix_web_message_feedback_rating", "web_message_feedback", ["rating"]
    )
    op.create_index(
        "ix_web_message_feedback_updated_at",
        "web_message_feedback",
        ["updated_at"],
    )
    op.create_index(
        "ix_web_message_feedback_user_updated",
        "web_message_feedback",
        ["user_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_table("web_message_feedback")
    with op.batch_alter_table("web_memory_fact") as batch:
        batch.drop_index("ix_web_memory_fact_accessed_at")
        batch.drop_column("accessed_at")
        batch.drop_column("embedding_norm")
        batch.drop_column("embedding_json")
