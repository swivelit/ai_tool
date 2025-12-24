"""create user_profile table

Revision ID: 15a6b511bb8c
Revises: xxxx_add_daily_routine
Create Date: 2025-12-24 05:58:52.756509

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '15a6b511bb8c'
down_revision: Union[str, Sequence[str], None] = 'xxxx_add_daily_routine'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade():
    op.create_table(
        "user_profile",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False, unique=True),
        sa.Column("answers_json", sa.Text(), nullable=False),
        sa.Column("questions_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("profile_summary", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),

        sa.ForeignKeyConstraint(
            ["user_id"],
            ["user.id"],
            ondelete="CASCADE",
        ),
    )


def downgrade():
    op.drop_table("user_profile")