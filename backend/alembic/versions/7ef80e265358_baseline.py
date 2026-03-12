"""baseline

Revision ID: 7ef80e265358
Revises:
Create Date: 2025-12-19 14:12:41.175600

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "7ef80e265358"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # user
    op.create_table(
        "user",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("place", sa.String(), nullable=True),
        sa.Column("timezone", sa.String(), nullable=False, server_default="Asia/Kolkata"),
        sa.Column("assistant_name", sa.String(), nullable=False, server_default="Ellie"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    # item
    op.create_table(
        "item",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("intent", sa.String(), nullable=False),
        sa.Column("category", sa.String(), nullable=False),
        sa.Column("raw_text", sa.String(), nullable=False),
        sa.Column("transcript", sa.String(), nullable=True),
        sa.Column("datetime_str", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("details", sa.String(), nullable=True),
        sa.Column("source", sa.String(), nullable=False, server_default="text"),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_item_user_id"), "item", ["user_id"], unique=False)

    # conversation
    op.create_table(
        "conversation",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("channel", sa.String(), nullable=False),
        sa.Column("user_input", sa.String(), nullable=False),
        sa.Column("transcript", sa.String(), nullable=True),
        sa.Column("llm_output_json", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_conversation_user_id"), "conversation", ["user_id"], unique=False)

    # qa_cache
    op.create_table(
        "qa_cache",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("question", sa.String(), nullable=False),
        sa.Column("answer", sa.String(), nullable=False),
        sa.Column("hits", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_qa_cache_user_id"), "qa_cache", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_qa_cache_user_id"), table_name="qa_cache")
    op.drop_table("qa_cache")

    op.drop_index(op.f("ix_conversation_user_id"), table_name="conversation")
    op.drop_table("conversation")

    op.drop_index(op.f("ix_item_user_id"), table_name="item")
    op.drop_table("item")

    op.drop_table("user")