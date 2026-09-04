"""add opaque website guest sessions

Revision ID: c7e4a1b9d2f6
Revises: b8f2c7d1e4a9
"""

from alembic import op
import sqlalchemy as sa


revision = "c7e4a1b9d2f6"
down_revision = "b8f2c7d1e4a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "web_guest_session",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_digest", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="RESTRICT"),
        sa.UniqueConstraint("token_digest", name="uq_web_guest_session_token_digest"),
    )
    op.create_index(
        "ix_web_guest_session_user_id", "web_guest_session", ["user_id"], unique=False
    )
    op.create_index(
        "ix_web_guest_session_token_digest", "web_guest_session", ["token_digest"], unique=False
    )
    op.create_index(
        "ix_web_guest_session_created_at", "web_guest_session", ["created_at"], unique=False
    )
    op.create_index(
        "ix_web_guest_session_last_seen_at", "web_guest_session", ["last_seen_at"], unique=False
    )
    op.create_index(
        "ix_web_guest_session_expires_at", "web_guest_session", ["expires_at"], unique=False
    )
    op.create_index(
        "ix_web_guest_session_revoked_at", "web_guest_session", ["revoked_at"], unique=False
    )
    op.create_index(
        "ix_web_guest_session_user_active", "web_guest_session",
        ["user_id", "expires_at", "revoked_at"], unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_web_guest_session_user_active", table_name="web_guest_session")
    op.drop_index("ix_web_guest_session_revoked_at", table_name="web_guest_session")
    op.drop_index("ix_web_guest_session_expires_at", table_name="web_guest_session")
    op.drop_index("ix_web_guest_session_last_seen_at", table_name="web_guest_session")
    op.drop_index("ix_web_guest_session_created_at", table_name="web_guest_session")
    op.drop_index("ix_web_guest_session_token_digest", table_name="web_guest_session")
    op.drop_index("ix_web_guest_session_user_id", table_name="web_guest_session")
    op.drop_table("web_guest_session")
