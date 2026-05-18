"""add agent traces

Revision ID: 2a3b4c5d6e7f
Revises: 1f2e3d4c5b6a
Create Date: 2026-05-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "2a3b4c5d6e7f"
down_revision: Union[str, Sequence[str], None] = "1f2e3d4c5b6a"
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
    if not _has_table("agent_run"):
        op.create_table(
            "agent_run",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=True),
            sa.Column("request_id", sa.String(), nullable=True),
            sa.Column("channel", sa.String(), nullable=False, server_default="text"),
            sa.Column("message_hash", sa.String(), nullable=False),
            sa.Column("message_preview", sa.String(), nullable=False, server_default=""),
            sa.Column("final_route", sa.String(), nullable=False),
            sa.Column("final_intent", sa.String(), nullable=False),
            sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
            sa.Column("provider_calls", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("estimated_cost_amount", sa.Float(), nullable=False, server_default="0"),
            sa.Column("estimated_cost_currency", sa.String(), nullable=False, server_default=""),
            sa.Column("metadata_json", sa.String(), nullable=False, server_default="{}"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )

    if not _has_table("agent_step"):
        op.create_table(
            "agent_step",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("run_id", sa.Integer(), nullable=False),
            sa.Column("step_name", sa.String(), nullable=False),
            sa.Column("input_json", sa.String(), nullable=False, server_default="{}"),
            sa.Column("output_json", sa.String(), nullable=False, server_default="{}"),
            sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
            sa.Column("duration_ms", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["run_id"], ["agent_run.id"]),
            sa.PrimaryKeyConstraint("id"),
        )

    for table_name, indexes in {
        "agent_run": {
            "ix_agent_run_user_id": ["user_id"],
            "ix_agent_run_request_id": ["request_id"],
            "ix_agent_run_channel": ["channel"],
            "ix_agent_run_message_hash": ["message_hash"],
            "ix_agent_run_final_route": ["final_route"],
            "ix_agent_run_final_intent": ["final_intent"],
            "ix_agent_run_confidence": ["confidence"],
            "ix_agent_run_created_at": ["created_at"],
        },
        "agent_step": {
            "ix_agent_step_run_id": ["run_id"],
            "ix_agent_step_step_name": ["step_name"],
            "ix_agent_step_confidence": ["confidence"],
            "ix_agent_step_created_at": ["created_at"],
        },
    }.items():
        for index_name, columns in indexes.items():
            _create_index(table_name, index_name, columns)


def downgrade() -> None:
    for table_name, indexes in {
        "agent_step": (
            "ix_agent_step_created_at",
            "ix_agent_step_confidence",
            "ix_agent_step_step_name",
            "ix_agent_step_run_id",
        ),
        "agent_run": (
            "ix_agent_run_created_at",
            "ix_agent_run_confidence",
            "ix_agent_run_final_intent",
            "ix_agent_run_final_route",
            "ix_agent_run_message_hash",
            "ix_agent_run_channel",
            "ix_agent_run_request_id",
            "ix_agent_run_user_id",
        ),
    }.items():
        if not _has_table(table_name):
            continue
        for index_name in indexes:
            if _has_index(table_name, index_name):
                op.drop_index(index_name, table_name=table_name)

    if _has_table("agent_step"):
        op.drop_table("agent_step")
    if _has_table("agent_run"):
        op.drop_table("agent_run")
