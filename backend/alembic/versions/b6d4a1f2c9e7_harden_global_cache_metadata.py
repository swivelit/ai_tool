"""harden global cache metadata

Revision ID: b6d4a1f2c9e7
Revises: 9f3c2a6d1b8e
Create Date: 2026-05-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "b6d4a1f2c9e7"
down_revision: Union[str, Sequence[str], None] = "9f3c2a6d1b8e"
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


def _create_index(table_name: str, index_name: str, columns: list[str]) -> None:
    if _has_table(table_name) and not _has_index(table_name, index_name):
        op.create_index(index_name, table_name, columns)


def upgrade() -> None:
    if _has_table("global_qa_cache") and not _has_column("global_qa_cache", "embedding_kind"):
        op.add_column(
            "global_qa_cache",
            sa.Column("embedding_kind", sa.String(), nullable=False, server_default="token_hash_v1"),
        )
    _create_index("global_qa_cache", "ix_global_qa_cache_embedding_kind", ["embedding_kind"])

    if _has_table("global_qa_observation") and not _has_column("global_qa_observation", "answer_similarity_score"):
        op.add_column(
            "global_qa_observation",
            sa.Column("answer_similarity_score", sa.Float(), nullable=False, server_default="1.0"),
        )
    if _has_table("global_qa_observation") and not _has_column("global_qa_observation", "conflicting_answer_hashes_json"):
        op.add_column(
            "global_qa_observation",
            sa.Column("conflicting_answer_hashes_json", sa.String(), nullable=False, server_default="[]"),
        )
    _create_index("global_qa_observation", "ix_global_qa_observation_answer_similarity_score", ["answer_similarity_score"])


def downgrade() -> None:
    if _has_table("global_qa_observation"):
        if _has_index("global_qa_observation", "ix_global_qa_observation_answer_similarity_score"):
            op.drop_index("ix_global_qa_observation_answer_similarity_score", table_name="global_qa_observation")
        if _has_column("global_qa_observation", "conflicting_answer_hashes_json"):
            op.drop_column("global_qa_observation", "conflicting_answer_hashes_json")
        if _has_column("global_qa_observation", "answer_similarity_score"):
            op.drop_column("global_qa_observation", "answer_similarity_score")

    if _has_table("global_qa_cache"):
        if _has_index("global_qa_cache", "ix_global_qa_cache_embedding_kind"):
            op.drop_index("ix_global_qa_cache_embedding_kind", table_name="global_qa_cache")
        if _has_column("global_qa_cache", "embedding_kind"):
            op.drop_column("global_qa_cache", "embedding_kind")
