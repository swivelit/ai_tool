"""bind planner generations to durable CLI action reservations

Revision ID: 20260913_cli_reservations
Revises: 20260912_cli_tier
"""

from alembic import op
import sqlalchemy as sa


revision = "20260913_cli_reservations"
down_revision = "20260912_cli_tier"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("cli_agent_step", sa.Column("reservation_id", sa.String(64), nullable=True))
    op.create_index("ix_cli_agent_step_reservation_id", "cli_agent_step", ["reservation_id"])


def downgrade() -> None:
    op.drop_index("ix_cli_agent_step_reservation_id", table_name="cli_agent_step")
    op.drop_column("cli_agent_step", "reservation_id")
