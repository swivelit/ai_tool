"""add branded Swico tiers to web preferences and usage audit rows

Revision ID: 9d2f6a1c4b7e
Revises: 8c1f4e7b2a90
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9d2f6a1c4b7e"
down_revision: Union[str, Sequence[str], None] = "8c1f4e7b2a90"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("web_usage_preferences") as batch:
        batch.add_column(
            sa.Column("assistant_tier", sa.String(16), nullable=False, server_default="lite")
        )
        batch.create_check_constraint(
            "ck_web_usage_preferences_assistant_tier",
            "assistant_tier IN ('lite','standard','pro')",
        )

    with op.batch_alter_table("web_chat_message") as batch:
        batch.add_column(sa.Column("swico_tier", sa.String(16), nullable=True))
        batch.create_check_constraint(
            "ck_web_chat_message_swico_tier",
            "swico_tier IS NULL OR swico_tier IN ('lite','standard','pro')",
        )
        batch.create_index("ix_web_chat_message_swico_tier", ["swico_tier"])

    with op.batch_alter_table("usage_charge") as batch:
        batch.add_column(sa.Column("swico_tier", sa.String(16), nullable=True))
        batch.create_check_constraint(
            "ck_usage_charge_swico_tier",
            "swico_tier IS NULL OR swico_tier IN ('lite','standard','pro')",
        )
        batch.create_index("ix_usage_charge_swico_tier", ["swico_tier"])


def downgrade() -> None:
    with op.batch_alter_table("usage_charge") as batch:
        batch.drop_index("ix_usage_charge_swico_tier")
        batch.drop_constraint("ck_usage_charge_swico_tier", type_="check")
        batch.drop_column("swico_tier")

    with op.batch_alter_table("web_chat_message") as batch:
        batch.drop_index("ix_web_chat_message_swico_tier")
        batch.drop_constraint("ck_web_chat_message_swico_tier", type_="check")
        batch.drop_column("swico_tier")

    with op.batch_alter_table("web_usage_preferences") as batch:
        batch.drop_constraint("ck_web_usage_preferences_assistant_tier", type_="check")
        batch.drop_column("assistant_tier")
