"""add TRIAG-RAG Phase 5 owner-scoped persistent knowledge

Revision ID: f2a7c9e4b1d6
Revises: d6f1a8c3e9b4
"""

from alembic import op
import sqlalchemy as sa


revision = "f2a7c9e4b1d6"
down_revision = "d6f1a8c3e9b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "web_knowledge_document",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("source_id", sa.String(160), nullable=False),
        sa.Column("source_version", sa.String(64), nullable=False),
        sa.Column("idempotency_key", sa.String(160), nullable=False),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column(
            "source_kind", sa.String(32), nullable=False,
            server_default="approved_document",
        ),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("approval_version", sa.String(24), nullable=False, server_default="v1"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("safe_metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["owner_user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "owner_user_id", "source_id", "source_version",
            name="uq_web_knowledge_document_owner_source_version",
        ),
        sa.UniqueConstraint(
            "owner_user_id", "idempotency_key",
            name="uq_web_knowledge_document_owner_idempotency",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'indexing', 'ready', 'invalidated', "
            "'failed', 'deleted')",
            name="ck_web_knowledge_document_status",
        ),
    )
    _indexes(
        "web_knowledge_document",
        ("owner_user_id", "source_id", "source_version", "source_kind",
         "content_hash", "status", "approved_at", "created_at", "updated_at",
         "deleted_at"),
    )
    op.create_index(
        "ix_web_knowledge_document_owner_status",
        "web_knowledge_document", ["owner_user_id", "status", "updated_at"],
    )

    op.create_table(
        "web_knowledge_chunk",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.String(36), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("source_version", sa.String(64), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content_text", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("source_locator", sa.String(512), nullable=False),
        sa.Column("section_path", sa.String(512), nullable=False, server_default=""),
        # JSON remains the canonical portable representation. PostgreSQL
        # retrieval casts it to pgvector only when that extension is present.
        sa.Column("embedding_json", sa.Text(), nullable=True),
        sa.Column("embedding_model", sa.String(128), nullable=True),
        sa.Column("embedding_version", sa.String(24), nullable=True),
        sa.Column("embedding_dimensions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("embedding_status", sa.String(16), nullable=False, server_default="missing"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"], ["web_knowledge_document.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "document_id", "source_version", "chunk_index",
            name="uq_web_knowledge_chunk_document_version_index",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'ready', 'invalidated', 'failed', 'deleted')",
            name="ck_web_knowledge_chunk_status",
        ),
    )
    _indexes(
        "web_knowledge_chunk",
        ("document_id", "owner_user_id", "source_version", "content_hash",
         "embedding_status", "status", "created_at", "updated_at"),
    )
    op.create_index(
        "ix_web_knowledge_chunk_owner_document_status",
        "web_knowledge_chunk", ["owner_user_id", "document_id", "status"],
    )
    op.create_index(
        "ix_web_knowledge_chunk_owner_hash",
        "web_knowledge_chunk", ["owner_user_id", "content_hash"],
    )
    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            "CREATE INDEX ix_web_knowledge_chunk_fts ON web_knowledge_chunk "
            "USING gin (to_tsvector('simple', content_text))"
        )

    op.create_table(
        "web_knowledge_triplet",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.String(36), nullable=False),
        sa.Column("chunk_id", sa.String(36), nullable=False),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("source_version", sa.String(64), nullable=False),
        sa.Column("condition_text", sa.Text(), nullable=False),
        sa.Column("proof_text", sa.Text(), nullable=False),
        sa.Column("conclusion_text", sa.Text(), nullable=False),
        sa.Column("extraction_version", sa.String(24), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("source_locator", sa.String(512), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ready"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"], ["web_knowledge_document.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["chunk_id"], ["web_knowledge_chunk.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "chunk_id", "extraction_version", "content_hash",
            name="uq_web_knowledge_triplet_chunk_version_hash",
        ),
        sa.CheckConstraint(
            "status IN ('ready', 'invalidated', 'failed', 'deleted')",
            name="ck_web_knowledge_triplet_status",
        ),
    )
    _indexes(
        "web_knowledge_triplet",
        ("document_id", "chunk_id", "owner_user_id", "source_version",
         "extraction_version", "content_hash", "status", "created_at", "updated_at"),
    )
    op.create_index(
        "ix_web_knowledge_triplet_owner_document_status",
        "web_knowledge_triplet", ["owner_user_id", "document_id", "status"],
    )

    op.create_table(
        "web_knowledge_node",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.String(36), nullable=False),
        sa.Column("parent_node_id", sa.String(36), nullable=True),
        sa.Column("raw_chunk_id", sa.String(36), nullable=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("source_version", sa.String(64), nullable=False),
        sa.Column("node_kind", sa.String(24), nullable=False),
        sa.Column("title", sa.String(256), nullable=False, server_default=""),
        sa.Column("summary_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("token_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("depth", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("ordinal", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("source_locator", sa.String(512), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ready"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["document_id"], ["web_knowledge_document.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["parent_node_id"], ["web_knowledge_node.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["raw_chunk_id"], ["web_knowledge_chunk.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["user.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "document_id", "source_version", "node_kind", "ordinal",
            name="uq_web_knowledge_node_document_version_kind_ordinal",
        ),
        sa.CheckConstraint(
            "node_kind IN ('document_summary', 'section_summary', 'raw_chunk')",
            name="ck_web_knowledge_node_kind",
        ),
        sa.CheckConstraint(
            "status IN ('ready', 'invalidated', 'failed', 'deleted')",
            name="ck_web_knowledge_node_status",
        ),
    )
    _indexes(
        "web_knowledge_node",
        ("document_id", "parent_node_id", "raw_chunk_id", "owner_user_id",
         "source_version", "node_kind", "content_hash", "status", "created_at",
         "updated_at"),
    )
    op.create_index(
        "ix_web_knowledge_node_owner_document_kind",
        "web_knowledge_node", ["owner_user_id", "document_id", "node_kind"],
    )


def _indexes(table: str, columns: tuple[str, ...]) -> None:
    for column in columns:
        op.create_index(f"ix_{table}_{column}", table, [column])


def downgrade() -> None:
    op.drop_table("web_knowledge_node")
    op.drop_table("web_knowledge_triplet")
    op.drop_table("web_knowledge_chunk")
    op.drop_table("web_knowledge_document")
