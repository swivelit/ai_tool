"""global qa user scope real embeddings

Revision ID: f1b2c3d4e5f6
Revises: 2a3b4c5d6e7f
Create Date: 2026-05-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "f1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "2a3b4c5d6e7f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    return inspect(op.get_bind()).has_table(table_name)


def _has_column(table_name: str, column_name: str) -> bool:
    if not _has_table(table_name):
        return False
    return column_name in {column["name"] for column in inspect(op.get_bind()).get_columns(table_name)}


def _has_index(table_name: str, index_name: str) -> bool:
    if not _has_table(table_name):
        return False
    return index_name in {idx["name"] for idx in inspect(op.get_bind()).get_indexes(table_name)}


def _add_column(table_name: str, column: sa.Column) -> None:
    if _has_table(table_name) and not _has_column(table_name, str(column.name)):
        op.add_column(table_name, column)


def _create_index(table_name: str, index_name: str, columns: list[str]) -> None:
    if _has_table(table_name) and not _has_index(table_name, index_name):
        op.create_index(index_name, table_name, columns)


def upgrade() -> None:
    _add_column("global_qa_cache", sa.Column("scope", sa.String(), nullable=False, server_default="global"))
    _add_column("global_qa_cache", sa.Column("user_id_hash", sa.String(), nullable=True))
    _add_column("global_qa_cache", sa.Column("token_hash_embedding_json", sa.String(), nullable=True))
    _add_column("global_qa_cache", sa.Column("token_hash_embedding_norm", sa.Float(), nullable=False, server_default="0.0"))
    _add_column("global_qa_cache", sa.Column("real_embedding_json", sa.String(), nullable=True))
    _add_column("global_qa_cache", sa.Column("real_embedding_norm", sa.Float(), nullable=False, server_default="0.0"))
    _add_column("global_qa_cache", sa.Column("real_embedding_kind", sa.String(), nullable=True))
    _create_index("global_qa_cache", "ix_global_qa_cache_scope", ["scope"])
    _create_index("global_qa_cache", "ix_global_qa_cache_user_id_hash", ["user_id_hash"])
    _create_index("global_qa_cache", "ix_global_qa_cache_real_embedding_kind", ["real_embedding_kind"])

    _add_column("ai_usage_events", sa.Column("cache_hit_source", sa.String(), nullable=True))
    _create_index("ai_usage_events", "ix_ai_usage_events_cache_hit_source", ["cache_hit_source"])


def downgrade() -> None:
    for table_name, index_name in (
        ("ai_usage_events", "ix_ai_usage_events_cache_hit_source"),
        ("global_qa_cache", "ix_global_qa_cache_real_embedding_kind"),
        ("global_qa_cache", "ix_global_qa_cache_user_id_hash"),
        ("global_qa_cache", "ix_global_qa_cache_scope"),
    ):
        if _has_index(table_name, index_name):
            op.drop_index(index_name, table_name=table_name)
    for table_name, column_name in (
        ("ai_usage_events", "cache_hit_source"),
        ("global_qa_cache", "real_embedding_kind"),
        ("global_qa_cache", "real_embedding_norm"),
        ("global_qa_cache", "real_embedding_json"),
        ("global_qa_cache", "token_hash_embedding_norm"),
        ("global_qa_cache", "token_hash_embedding_json"),
        ("global_qa_cache", "user_id_hash"),
        ("global_qa_cache", "scope"),
    ):
        if _has_column(table_name, column_name):
            op.drop_column(table_name, column_name)
