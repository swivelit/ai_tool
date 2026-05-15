"""add global qa cache

Revision ID: 9f3c2a6d1b8e
Revises: 4c6f9f7a5d21
Create Date: 2026-05-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "9f3c2a6d1b8e"
down_revision: Union[str, Sequence[str], None] = "4c6f9f7a5d21"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table_name: str) -> bool:
    return inspect(op.get_bind()).has_table(table_name)


def _has_index(table_name: str, index_name: str) -> bool:
    return index_name in {idx["name"] for idx in inspect(op.get_bind()).get_indexes(table_name)}


def _create_index(table_name: str, index_name: str, columns: list[str], *, unique: bool = False) -> None:
    if not _has_index(table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=unique)


def upgrade() -> None:
    if not _has_table("global_qa_cache"):
        op.create_table(
            "global_qa_cache",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("canonical_question", sa.String(), nullable=False),
            sa.Column("normalized_question", sa.String(), nullable=False),
            sa.Column("answer", sa.String(), nullable=False),
            sa.Column("answer_language", sa.String(), nullable=False, server_default="en"),
            sa.Column("topic", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False, server_default="candidate"),
            sa.Column("hit_count", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("distinct_user_count", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("observed_question_count", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("source_question_hashes_json", sa.String(), nullable=False, server_default="[]"),
            sa.Column("answer_hash", sa.String(), nullable=False),
            sa.Column("embedding_json", sa.String(), nullable=True),
            sa.Column("embedding_norm", sa.Float(), nullable=False, server_default="0.0"),
            sa.Column("confidence", sa.Float(), nullable=False, server_default="0.0"),
            sa.Column("safety_label", sa.String(), nullable=False, server_default="general"),
            sa.Column("model_used", sa.String(), nullable=True),
            sa.Column("first_seen_at", sa.DateTime(), nullable=False),
            sa.Column("last_seen_at", sa.DateTime(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.Column("reviewed_at", sa.DateTime(), nullable=True),
            sa.Column("review_notes", sa.String(), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )

    for index_name, columns in {
        "ix_global_qa_cache_normalized_question": ["normalized_question"],
        "ix_global_qa_cache_answer_language": ["answer_language"],
        "ix_global_qa_cache_topic": ["topic"],
        "ix_global_qa_cache_status": ["status"],
        "ix_global_qa_cache_hit_count": ["hit_count"],
        "ix_global_qa_cache_distinct_user_count": ["distinct_user_count"],
        "ix_global_qa_cache_answer_hash": ["answer_hash"],
        "ix_global_qa_cache_safety_label": ["safety_label"],
        "ix_global_qa_cache_model_used": ["model_used"],
        "ix_global_qa_cache_first_seen_at": ["first_seen_at"],
        "ix_global_qa_cache_last_seen_at": ["last_seen_at"],
        "ix_global_qa_cache_expires_at": ["expires_at"],
        "ix_global_qa_cache_updated_at": ["updated_at"],
    }.items():
        _create_index("global_qa_cache", index_name, columns)

    if not _has_table("global_qa_observation"):
        op.create_table(
            "global_qa_observation",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("global_cache_id", sa.Integer(), nullable=False),
            sa.Column("user_id_hash", sa.String(), nullable=False),
            sa.Column("question_hash", sa.String(), nullable=False),
            sa.Column("normalized_question", sa.String(), nullable=False),
            sa.Column("similarity_score", sa.Float(), nullable=False, server_default="0.0"),
            sa.Column("backend_answer_hash", sa.String(), nullable=False),
            sa.Column("model_used", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["global_cache_id"], ["global_qa_cache.id"]),
            sa.PrimaryKeyConstraint("id"),
        )

    for index_name, columns in {
        "ix_global_qa_observation_global_cache_id": ["global_cache_id"],
        "ix_global_qa_observation_user_id_hash": ["user_id_hash"],
        "ix_global_qa_observation_question_hash": ["question_hash"],
        "ix_global_qa_observation_similarity_score": ["similarity_score"],
        "ix_global_qa_observation_backend_answer_hash": ["backend_answer_hash"],
        "ix_global_qa_observation_model_used": ["model_used"],
        "ix_global_qa_observation_created_at": ["created_at"],
    }.items():
        _create_index("global_qa_observation", index_name, columns)

    if not _has_table("openai_usage_log"):
        op.create_table(
            "openai_usage_log",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("request_id", sa.String(), nullable=True),
            sa.Column("user_id_hash", sa.String(), nullable=True),
            sa.Column("route", sa.String(), nullable=False),
            sa.Column("model_used", sa.String(), nullable=False),
            sa.Column("model_tier", sa.String(), nullable=False),
            sa.Column("reason", sa.String(), nullable=True),
            sa.Column("estimated_input_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("estimated_output_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("estimated_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
            sa.Column("cache_hit", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )

    for index_name, columns in {
        "ix_openai_usage_log_request_id": ["request_id"],
        "ix_openai_usage_log_user_id_hash": ["user_id_hash"],
        "ix_openai_usage_log_route": ["route"],
        "ix_openai_usage_log_model_used": ["model_used"],
        "ix_openai_usage_log_model_tier": ["model_tier"],
        "ix_openai_usage_log_cache_hit": ["cache_hit"],
        "ix_openai_usage_log_created_at": ["created_at"],
    }.items():
        _create_index("openai_usage_log", index_name, columns)


def downgrade() -> None:
    for table_name in ("openai_usage_log", "global_qa_observation", "global_qa_cache"):
        if _has_table(table_name):
            op.drop_table(table_name)

