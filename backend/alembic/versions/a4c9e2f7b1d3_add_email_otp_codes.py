"""add email otp codes

Revision ID: a4c9e2f7b1d3
Revises: f1b2c3d4e5f6
Create Date: 2026-06-06 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "a4c9e2f7b1d3"
down_revision: Union[str, Sequence[str], None] = "f1b2c3d4e5f6"
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
    if not _has_table("email_otp_code"):
        op.create_table(
            "email_otp_code",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("email", sa.String(), nullable=False),
            sa.Column("purpose", sa.String(), nullable=False),
            sa.Column("otp_hash", sa.String(), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("expires_at", sa.DateTime(), nullable=False),
            sa.Column("consumed_at", sa.DateTime(), nullable=True),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_sent_at", sa.DateTime(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )

    _create_index("email_otp_code", "ix_email_otp_code_email", ["email"])
    _create_index("email_otp_code", "ix_email_otp_code_purpose", ["purpose"])
    _create_index("email_otp_code", "ix_email_otp_code_created_at", ["created_at"])
    _create_index("email_otp_code", "ix_email_otp_code_expires_at", ["expires_at"])
    _create_index("email_otp_code", "ix_email_otp_code_consumed_at", ["consumed_at"])
    _create_index("email_otp_code", "ix_email_otp_code_last_sent_at", ["last_sent_at"])


def downgrade() -> None:
    if _has_table("email_otp_code"):
        for index_name in (
            "ix_email_otp_code_last_sent_at",
            "ix_email_otp_code_consumed_at",
            "ix_email_otp_code_expires_at",
            "ix_email_otp_code_created_at",
            "ix_email_otp_code_purpose",
            "ix_email_otp_code_email",
        ):
            if _has_index("email_otp_code", index_name):
                op.drop_index(index_name, table_name="email_otp_code")
        op.drop_table("email_otp_code")
