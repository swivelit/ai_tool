"""persist an explicit paid tier selected for CLI authorization

Revision ID: 20260912_cli_tier
Revises: d1c7e5b9a312
"""

from alembic import op
import sqlalchemy as sa


revision = "20260912_cli_tier"
down_revision = "d1c7e5b9a312"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("cli_device_grant", sa.Column("requested_tier", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("cli_device_grant", "requested_tier")
