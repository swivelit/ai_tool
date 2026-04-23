"""add runtime-managed schema to alembic

Revision ID: 4c6f9f7a5d21
Revises: 15a6b511bb8c
Create Date: 2026-04-23 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = "4c6f9f7a5d21"
down_revision: Union[str, Sequence[str], None] = "15a6b511bb8c"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = inspect(bind)
    return column_name in {column["name"] for column in inspector.get_columns(table_name)}


def _has_table(table_name: str) -> bool:
    bind = op.get_bind()
    inspector = inspect(bind)
    return inspector.has_table(table_name)


def _has_index(table_name: str, index_name: str) -> bool:
    bind = op.get_bind()
    inspector = inspect(bind)
    return index_name in {index["name"] for index in inspector.get_indexes(table_name)}


def _drop_index_if_exists(table_name: str, index_name: str) -> None:
    if _has_index(table_name, index_name):
        op.drop_index(index_name, table_name=table_name)


def upgrade() -> None:
    if not _has_column("user", "firebase_uid"):
        op.add_column("user", sa.Column("firebase_uid", sa.String(), nullable=True))

    if not _has_column("user", "email"):
        op.add_column("user", sa.Column("email", sa.String(), nullable=True))

    if not _has_column("user", "reply_language"):
        op.add_column(
            "user",
            sa.Column("reply_language", sa.String(), nullable=False, server_default="ta"),
        )

    _drop_index_if_exists("user", "ix_user_firebase_uid_unique")
    _drop_index_if_exists("user", "ix_user_email_unique")

    if not _has_index("user", "ix_user_firebase_uid"):
        op.create_index("ix_user_firebase_uid", "user", ["firebase_uid"], unique=True)

    if not _has_index("user", "ix_user_email"):
        op.create_index("ix_user_email", "user", ["email"], unique=True)

    if not _has_table("rag_embedding"):
        op.create_table(
            "rag_embedding",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=True),
            sa.Column("source_type", sa.String(), nullable=False),
            sa.Column("source_id", sa.String(), nullable=False),
            sa.Column("content_hash", sa.String(), nullable=False),
            sa.Column("content_text", sa.String(), nullable=False),
            sa.Column("embedding_json", sa.String(), nullable=False),
            sa.Column("embedding_norm", sa.Float(), nullable=False, server_default="0.0"),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
            sa.PrimaryKeyConstraint("id"),
        )

    if not _has_index("rag_embedding", "ix_rag_embedding_user_id"):
        op.create_index("ix_rag_embedding_user_id", "rag_embedding", ["user_id"], unique=False)

    if not _has_index("rag_embedding", "ix_rag_embedding_source_type"):
        op.create_index("ix_rag_embedding_source_type", "rag_embedding", ["source_type"], unique=False)

    if not _has_index("rag_embedding", "ix_rag_embedding_source_id"):
        op.create_index("ix_rag_embedding_source_id", "rag_embedding", ["source_id"], unique=False)

    if not _has_index("rag_embedding", "ix_rag_embedding_content_hash"):
        op.create_index("ix_rag_embedding_content_hash", "rag_embedding", ["content_hash"], unique=False)

    if not _has_index("rag_embedding", "ix_rag_embedding_updated_at"):
        op.create_index("ix_rag_embedding_updated_at", "rag_embedding", ["updated_at"], unique=False)

    if not _has_index("rag_embedding", "ix_rag_embedding_content_hash_unique"):
        op.create_index(
            "ix_rag_embedding_content_hash_unique",
            "rag_embedding",
            ["content_hash"],
            unique=True,
        )

    if not _has_index("rag_embedding", "ix_rag_embedding_user_source_updated"):
        op.create_index(
            "ix_rag_embedding_user_source_updated",
            "rag_embedding",
            ["user_id", "source_type", "updated_at"],
            unique=False,
        )

    if not _has_index("rag_embedding", "ix_rag_embedding_user_updated"):
        op.create_index(
            "ix_rag_embedding_user_updated",
            "rag_embedding",
            ["user_id", "updated_at"],
            unique=False,
        )

    if not _has_table("job"):
        op.create_table(
            "job",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=True),
            sa.Column("job_type", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False, server_default="queued"),
            sa.Column("payload_json", sa.String(), nullable=False),
            sa.Column("result_json", sa.String(), nullable=True),
            sa.Column("error_message", sa.String(), nullable=True),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
            sa.Column("run_at", sa.DateTime(), nullable=False),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("finished_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.Column("updated_at", sa.DateTime(), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
            sa.PrimaryKeyConstraint("id"),
        )

    if not _has_index("job", "ix_job_user_id"):
        op.create_index("ix_job_user_id", "job", ["user_id"], unique=False)

    if not _has_index("job", "ix_job_job_type"):
        op.create_index("ix_job_job_type", "job", ["job_type"], unique=False)

    if not _has_index("job", "ix_job_status"):
        op.create_index("ix_job_status", "job", ["status"], unique=False)

    if not _has_index("job", "ix_job_run_at"):
        op.create_index("ix_job_run_at", "job", ["run_at"], unique=False)


def downgrade() -> None:
    if _has_index("job", "ix_job_run_at"):
        op.drop_index("ix_job_run_at", table_name="job")
    if _has_index("job", "ix_job_status"):
        op.drop_index("ix_job_status", table_name="job")
    if _has_index("job", "ix_job_job_type"):
        op.drop_index("ix_job_job_type", table_name="job")
    if _has_index("job", "ix_job_user_id"):
        op.drop_index("ix_job_user_id", table_name="job")
    if _has_table("job"):
        op.drop_table("job")

    if _has_index("rag_embedding", "ix_rag_embedding_user_updated"):
        op.drop_index("ix_rag_embedding_user_updated", table_name="rag_embedding")
    if _has_index("rag_embedding", "ix_rag_embedding_user_source_updated"):
        op.drop_index("ix_rag_embedding_user_source_updated", table_name="rag_embedding")
    if _has_index("rag_embedding", "ix_rag_embedding_content_hash_unique"):
        op.drop_index("ix_rag_embedding_content_hash_unique", table_name="rag_embedding")
    if _has_index("rag_embedding", "ix_rag_embedding_updated_at"):
        op.drop_index("ix_rag_embedding_updated_at", table_name="rag_embedding")
    if _has_index("rag_embedding", "ix_rag_embedding_content_hash"):
        op.drop_index("ix_rag_embedding_content_hash", table_name="rag_embedding")
    if _has_index("rag_embedding", "ix_rag_embedding_source_id"):
        op.drop_index("ix_rag_embedding_source_id", table_name="rag_embedding")
    if _has_index("rag_embedding", "ix_rag_embedding_source_type"):
        op.drop_index("ix_rag_embedding_source_type", table_name="rag_embedding")
    if _has_index("rag_embedding", "ix_rag_embedding_user_id"):
        op.drop_index("ix_rag_embedding_user_id", table_name="rag_embedding")
    if _has_table("rag_embedding"):
        op.drop_table("rag_embedding")

    if _has_index("user", "ix_user_email"):
        op.drop_index("ix_user_email", table_name="user")
    if _has_index("user", "ix_user_firebase_uid"):
        op.drop_index("ix_user_firebase_uid", table_name="user")

    if _has_column("user", "reply_language"):
        op.drop_column("user", "reply_language")
    if _has_column("user", "email"):
        op.drop_column("user", "email")
    if _has_column("user", "firebase_uid"):
        op.drop_column("user", "firebase_uid")