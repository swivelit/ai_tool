"""Add exact STT and TTS usage dimensions to usage charges.

Revision ID: c5d8a2e9f4b1
Revises: a7c4e9d2f1b6
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c5d8a2e9f4b1"
down_revision: Union[str, Sequence[str], None] = "a7c4e9d2f1b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "usage_charge",
        sa.Column("usage_kind", sa.String(length=16), nullable=False, server_default="chat"),
    )
    op.add_column(
        "usage_charge",
        sa.Column("voice_turn_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "usage_charge",
        sa.Column("audio_milliseconds", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.add_column(
        "usage_charge",
        sa.Column("characters", sa.Integer(), nullable=False, server_default="0"),
    )
    # Be explicit for databases whose DDL default behavior differs. No existing
    # financial, request, tier, or audit columns are rewritten.
    op.execute("UPDATE usage_charge SET usage_kind = 'chat' WHERE usage_kind IS NULL")
    op.create_index(
        "ix_usage_charge_voice_turn_id", "usage_charge", ["voice_turn_id"], unique=False
    )
    op.create_index(
        "ix_usage_charge_user_kind_settled",
        "usage_charge",
        ["user_id", "usage_kind", "settled_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_usage_charge_user_kind_settled", table_name="usage_charge")
    op.drop_index("ix_usage_charge_voice_turn_id", table_name="usage_charge")
    op.drop_column("usage_charge", "characters")
    op.drop_column("usage_charge", "audio_milliseconds")
    op.drop_column("usage_charge", "voice_turn_id")
    op.drop_column("usage_charge", "usage_kind")
