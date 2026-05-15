"""global cache aliases tombstones usage actuals

Revision ID: c3f1a8d4e6b2
Revises: b6d4a1f2c9e7
Create Date: 2026-05-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "c3f1a8d4e6b2"
down_revision: Union[str, Sequence[str], None] = "b6d4a1f2c9e7"
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
    if _has_table("global_qa_cache"):
        if not _has_column("global_qa_cache", "observed_safe_questions_json"):
            op.add_column(
                "global_qa_cache",
                sa.Column("observed_safe_questions_json", sa.String(), nullable=False, server_default="[]"),
            )
        if not _has_column("global_qa_cache", "aliases_json"):
            op.add_column(
                "global_qa_cache",
                sa.Column("aliases_json", sa.String(), nullable=False, server_default="[]"),
            )

    if not _has_table("global_qa_tombstone"):
        op.create_table(
            "global_qa_tombstone",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("global_cache_id", sa.Integer(), nullable=False),
            sa.Column("deleted_at", sa.DateTime(), nullable=False),
            sa.Column("reason", sa.String(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
    _create_index("global_qa_tombstone", "ix_global_qa_tombstone_global_cache_id", ["global_cache_id"])
    _create_index("global_qa_tombstone", "ix_global_qa_tombstone_deleted_at", ["deleted_at"])

    if _has_table("openai_usage_log"):
        if not _has_column("openai_usage_log", "actual_input_tokens"):
            op.add_column("openai_usage_log", sa.Column("actual_input_tokens", sa.Integer(), nullable=True))
        if not _has_column("openai_usage_log", "actual_output_tokens"):
            op.add_column("openai_usage_log", sa.Column("actual_output_tokens", sa.Integer(), nullable=True))
        if not _has_column("openai_usage_log", "actual_cost_usd"):
            op.add_column("openai_usage_log", sa.Column("actual_cost_usd", sa.Float(), nullable=True))


def downgrade() -> None:
    if _has_table("openai_usage_log"):
        for column_name in ("actual_cost_usd", "actual_output_tokens", "actual_input_tokens"):
            if _has_column("openai_usage_log", column_name):
                op.drop_column("openai_usage_log", column_name)

    if _has_table("global_qa_tombstone"):
        if _has_index("global_qa_tombstone", "ix_global_qa_tombstone_deleted_at"):
            op.drop_index("ix_global_qa_tombstone_deleted_at", table_name="global_qa_tombstone")
        if _has_index("global_qa_tombstone", "ix_global_qa_tombstone_global_cache_id"):
            op.drop_index("ix_global_qa_tombstone_global_cache_id", table_name="global_qa_tombstone")
        op.drop_table("global_qa_tombstone")

    if _has_table("global_qa_cache"):
        for column_name in ("aliases_json", "observed_safe_questions_json"):
            if _has_column("global_qa_cache", column_name):
                op.drop_column("global_qa_cache", column_name)
