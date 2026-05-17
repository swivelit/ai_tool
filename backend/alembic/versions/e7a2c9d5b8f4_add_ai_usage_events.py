"""add ai usage events

Revision ID: e7a2c9d5b8f4
Revises: d8e9f0a1b2c3
Create Date: 2026-05-17 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "e7a2c9d5b8f4"
down_revision: Union[str, Sequence[str], None] = "d8e9f0a1b2c3"
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
    if not _has_table("ai_usage_events"):
        op.create_table(
            "ai_usage_events",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("request_id", sa.String(), nullable=True),
            sa.Column("user_id_hash", sa.String(), nullable=True),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=True),
            sa.Column("route", sa.String(), nullable=False),
            sa.Column("intent", sa.String(), nullable=False),
            sa.Column("language", sa.String(), nullable=False),
            sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("audio_seconds", sa.Float(), nullable=False, server_default="0"),
            sa.Column("characters", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("estimated_cost_amount", sa.Float(), nullable=False, server_default="0"),
            sa.Column("estimated_cost_currency", sa.String(), nullable=False, server_default=""),
            sa.Column("cache_hit", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("latency_ms", sa.Integer(), nullable=True),
            sa.Column("metadata_json", sa.String(), nullable=False, server_default="{}"),
            sa.PrimaryKeyConstraint("id"),
        )

    _create_index("ai_usage_events", "ix_ai_usage_events_created_at", ["created_at"])
    _create_index("ai_usage_events", "ix_ai_usage_events_user_id_hash", ["user_id_hash"])
    _create_index("ai_usage_events", "ix_ai_usage_events_provider", ["provider"])
    _create_index("ai_usage_events", "ix_ai_usage_events_model", ["model"])
    _create_index("ai_usage_events", "ix_ai_usage_events_route", ["route"])
    _create_index("ai_usage_events", "ix_ai_usage_events_intent", ["intent"])
    _create_index("ai_usage_events", "ix_ai_usage_events_language", ["language"])
    _create_index("ai_usage_events", "ix_ai_usage_events_cache_hit", ["cache_hit"])


def downgrade() -> None:
    if _has_table("ai_usage_events"):
        for index_name in (
            "ix_ai_usage_events_cache_hit",
            "ix_ai_usage_events_language",
            "ix_ai_usage_events_intent",
            "ix_ai_usage_events_route",
            "ix_ai_usage_events_model",
            "ix_ai_usage_events_provider",
            "ix_ai_usage_events_user_id_hash",
            "ix_ai_usage_events_created_at",
        ):
            if _has_index("ai_usage_events", index_name):
                op.drop_index(index_name, table_name="ai_usage_events")
        op.drop_table("ai_usage_events")
