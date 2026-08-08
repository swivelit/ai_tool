"""allow Swico Free in the existing web tier constraints

Revision ID: 7b4c9e1a2d6f
Revises: f2a7c9e4b1d6
"""
from typing import Sequence, Union

from alembic import op


revision: str = "7b4c9e1a2d6f"
down_revision: Union[str, Sequence[str], None] = "f2a7c9e4b1d6"
branch_labels = None
depends_on = None


_TIER_CHECKS = {
    "web_usage_preferences": (
        "assistant_tier IN ('free','lite','standard','pro')",
        "ck_web_usage_preferences_assistant_tier",
    ),
    "web_chat_message": (
        "swico_tier IS NULL OR swico_tier IN ('free','lite','standard','pro')",
        "ck_web_chat_message_swico_tier",
    ),
    "usage_charge": (
        "swico_tier IS NULL OR swico_tier IN ('free','lite','standard','pro')",
        "ck_usage_charge_swico_tier",
    ),
}


def upgrade() -> None:
    for table, (condition, name) in _TIER_CHECKS.items():
        with op.batch_alter_table(table) as batch:
            batch.drop_constraint(name, type_="check")
            batch.create_check_constraint(name, condition)


def downgrade() -> None:
    for table, (_condition, name) in _TIER_CHECKS.items():
        with op.batch_alter_table(table) as batch:
            batch.drop_constraint(name, type_="check")
            old_condition = (
                "assistant_tier IN ('lite','standard','pro')"
                if table == "web_usage_preferences"
                else "swico_tier IS NULL OR swico_tier IN ('lite','standard','pro')"
            )
            batch.create_check_constraint(name, old_condition)
