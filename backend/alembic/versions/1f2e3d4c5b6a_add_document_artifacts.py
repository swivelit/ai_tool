"""add document artifacts

Revision ID: 1f2e3d4c5b6a
Revises: e7a2c9d5b8f4
Create Date: 2026-05-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "1f2e3d4c5b6a"
down_revision: Union[str, Sequence[str], None] = "e7a2c9d5b8f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    return inspect(op.get_bind()).has_table(table_name)


def _has_index(table_name: str, index_name: str) -> bool:
    if not _has_table(table_name):
        return False
    return index_name in {idx["name"] for idx in inspect(op.get_bind()).get_indexes(table_name)}


def _create_index(table_name: str, index_name: str, columns: list[str]) -> None:
    if _has_table(table_name) and not _has_index(table_name, index_name):
        op.create_index(index_name, table_name, columns)


def upgrade() -> None:
    if not _has_table("document_artifact"):
        op.create_table(
            "document_artifact",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("item_id", sa.Integer(), nullable=True),
            sa.Column("title", sa.String(), nullable=False),
            sa.Column("format", sa.String(), nullable=False),
            sa.Column("category", sa.String(), nullable=False, server_default="Other"),
            sa.Column("relative_path", sa.String(), nullable=False),
            sa.Column("source_text", sa.String(), nullable=False, server_default=""),
            sa.Column("metadata_json", sa.String(), nullable=False, server_default="{}"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["item_id"], ["item.id"]),
            sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
            sa.PrimaryKeyConstraint("id"),
        )

    _create_index("document_artifact", "ix_document_artifact_user_id", ["user_id"])
    _create_index("document_artifact", "ix_document_artifact_item_id", ["item_id"])
    _create_index("document_artifact", "ix_document_artifact_title", ["title"])
    _create_index("document_artifact", "ix_document_artifact_format", ["format"])
    _create_index("document_artifact", "ix_document_artifact_category", ["category"])
    _create_index("document_artifact", "ix_document_artifact_created_at", ["created_at"])


def downgrade() -> None:
    if _has_table("document_artifact"):
        for index_name in (
            "ix_document_artifact_created_at",
            "ix_document_artifact_category",
            "ix_document_artifact_format",
            "ix_document_artifact_title",
            "ix_document_artifact_item_id",
            "ix_document_artifact_user_id",
        ):
            if _has_index("document_artifact", index_name):
                op.drop_index(index_name, table_name="document_artifact")
        op.drop_table("document_artifact")
