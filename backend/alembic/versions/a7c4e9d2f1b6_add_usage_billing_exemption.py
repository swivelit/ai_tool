"""add usage billing exemption audit field

Revision ID: a7c4e9d2f1b6
Revises: 9d2f6a1c4b7e
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7c4e9d2f1b6"
down_revision: Union[str, Sequence[str], None] = "9d2f6a1c4b7e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("usage_charge") as batch:
        batch.add_column(sa.Column("billing_exemption_reason", sa.String(64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("usage_charge") as batch:
        batch.drop_column("billing_exemption_reason")
