"""add daily_routine table

Revision ID: 825a0a39ad0e
Revises: 7ef80e265358
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "825a0a39ad0e"
down_revision: Union[str, Sequence[str], None] = "7ef80e265358"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "daily_routine",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id"), nullable=False, unique=True),
        sa.Column("wake_time", sa.String(), nullable=False),
        sa.Column("sleep_time", sa.String(), nullable=False),
        sa.Column("work_start", sa.String(), nullable=True),
        sa.Column("work_end", sa.String(), nullable=True),
        sa.Column("daily_habits", sa.String(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("daily_routine")