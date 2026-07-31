"""add TRIAG-RAG Phase 4 temporary code repository metadata

Revision ID: d6f1a8c3e9b4
Revises: b4e8c1d6a2f9
"""

from alembic import op
import sqlalchemy as sa


revision = "d6f1a8c3e9b4"
down_revision = "b4e8c1d6a2f9"
branch_labels = None
depends_on = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "web_code_repository",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("repository_id", sa.String(36), nullable=False),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("scope", sa.String(24), nullable=False, server_default="temporary"),
        sa.Column("source_version", sa.String(64), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="indexing"),
        sa.Column("safe_metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_user_id"], ["user.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "status IN ('indexing', 'ready', 'expired', 'rejected', 'failed')",
            name="ck_web_code_repository_status",
        ),
        sa.UniqueConstraint(
            "owner_user_id", "repository_id", "source_version",
            name="uq_web_code_repository_owner_version",
        ),
        sa.UniqueConstraint(
            "owner_user_id", "idempotency_key",
            name="uq_web_code_repository_owner_idempotency",
        ),
    )
    _indexes("web_code_repository", (
        "owner_user_id", "repository_id", "scope", "source_version", "status",
        "expires_at", "created_at", "updated_at",
    ))
    op.create_index(
        "ix_web_code_repository_owner_repository",
        "web_code_repository", ["owner_user_id", "repository_id"],
    )

    op.create_table(
        "web_code_file",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("repository_row_id", sa.String(36), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("repository_id", sa.String(36), nullable=False),
        sa.Column("source_version", sa.String(64), nullable=False),
        sa.Column("normalized_path", sa.String(512), nullable=False),
        sa.Column("language", sa.String(32), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("line_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="ready"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["repository_row_id"], ["web_code_repository.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "repository_row_id", "normalized_path",
            name="uq_web_code_file_repository_path",
        ),
    )
    _indexes("web_code_file", (
        "repository_row_id", "owner_user_id", "repository_id",
        "source_version", "language", "status", "expires_at", "created_at",
        "updated_at",
    ))
    op.create_index(
        "ix_web_code_file_owner_repository_path", "web_code_file",
        ["owner_user_id", "repository_id", "normalized_path"],
    )

    op.create_table(
        "web_code_symbol",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("repository_row_id", sa.String(36), nullable=False),
        sa.Column("file_id", sa.String(36), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("repository_id", sa.String(36), nullable=False),
        sa.Column("normalized_path", sa.String(512), nullable=False),
        sa.Column("symbol_name", sa.String(160), nullable=False),
        sa.Column("symbol_kind", sa.String(32), nullable=False),
        sa.Column("signature", sa.String(512), nullable=False, server_default=""),
        sa.Column("start_line", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("end_line", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ready"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["repository_row_id"], ["web_code_repository.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["file_id"], ["web_code_file.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["owner_user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "file_id", "symbol_name", "symbol_kind", "start_line",
            name="uq_web_code_symbol_file_symbol_line",
        ),
    )
    _indexes("web_code_symbol", (
        "repository_row_id", "file_id", "owner_user_id", "repository_id",
        "symbol_name", "symbol_kind", "status", "expires_at", "created_at",
    ))
    op.create_index(
        "ix_web_code_symbol_owner_repository_name", "web_code_symbol",
        ["owner_user_id", "repository_id", "symbol_name"],
    )

    op.create_table(
        "web_code_edge",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("repository_row_id", sa.String(36), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("repository_id", sa.String(36), nullable=False),
        sa.Column("source_version", sa.String(64), nullable=False),
        sa.Column("source_locator", sa.String(512), nullable=False),
        sa.Column("target_locator", sa.String(512), nullable=False),
        sa.Column("edge_kind", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ready"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["repository_row_id"], ["web_code_repository.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "repository_row_id", "source_locator", "target_locator", "edge_kind",
            name="uq_web_code_edge_repository_edge",
        ),
    )
    _indexes("web_code_edge", (
        "repository_row_id", "owner_user_id", "repository_id", "source_version",
        "edge_kind", "status", "expires_at", "created_at",
    ))
    op.create_index(
        "ix_web_code_edge_owner_repository_source", "web_code_edge",
        ["owner_user_id", "repository_id", "source_locator"],
    )


def _indexes(table: str, columns: tuple[str, ...]) -> None:
    for column in columns:
        op.create_index(f"ix_{table}_{column}", table, [column])


def downgrade() -> None:
    op.drop_table("web_code_edge")
    op.drop_table("web_code_symbol")
    op.drop_table("web_code_file")
    op.drop_table("web_code_repository")
