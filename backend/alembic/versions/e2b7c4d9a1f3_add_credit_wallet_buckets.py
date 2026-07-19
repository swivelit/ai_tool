"""Add independent Chat and Voice credit wallet buckets.

Revision ID: e2b7c4d9a1f3
Revises: c5d8a2e9f4b1
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e2b7c4d9a1f3"
down_revision: Union[str, Sequence[str], None] = "c5d8a2e9f4b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Defaults deliberately classify all historical money and usage as Chat.
    for table in ("wallet_account", "wallet_ledger", "payment_order", "usage_charge"):
        with op.batch_alter_table(table) as batch:
            batch.add_column(
                sa.Column("credit_bucket", sa.String(length=16), nullable=False, server_default="chat")
            )
        op.execute(sa.text(f"UPDATE {table} SET credit_bucket = 'chat' WHERE credit_bucket IS NULL"))
        with op.batch_alter_table(table) as batch:
            batch.create_check_constraint(
                f"ck_{table}_credit_bucket", "credit_bucket IN ('chat', 'voice')"
            )

    with op.batch_alter_table("wallet_account") as batch:
        batch.drop_constraint("uq_wallet_account_user_id", type_="unique")
        batch.create_unique_constraint(
            "uq_wallet_account_user_bucket", ["user_id", "credit_bucket"]
        )
    op.create_index(
        "ix_wallet_ledger_user_bucket_created",
        "wallet_ledger",
        ["user_id", "credit_bucket", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    # The legacy schema cannot represent Voice financial activity. Refuse a
    # lossy rollback after the feature has handled money or usage; a zero-only
    # lazily-created Voice wallet is safe to remove.
    connection = op.get_bind()
    voice_activity = sum(
        int(connection.execute(sa.text(
            f"SELECT COUNT(*) FROM {table} WHERE credit_bucket = 'voice'"
        )).scalar_one())
        for table in ("wallet_ledger", "payment_order", "usage_charge")
    )
    funded_voice_wallets = int(connection.execute(sa.text(
        "SELECT COUNT(*) FROM wallet_account WHERE credit_bucket = 'voice' "
        "AND (balance_micros <> 0 OR reserved_micros <> 0)"
    )).scalar_one())
    if voice_activity or funded_voice_wallets:
        raise RuntimeError(
            "Refusing to downgrade credit buckets because Voice financial activity exists."
        )
    op.execute(sa.text("DELETE FROM wallet_account WHERE credit_bucket = 'voice'"))
    op.drop_index("ix_wallet_ledger_user_bucket_created", table_name="wallet_ledger")
    with op.batch_alter_table("wallet_account") as batch:
        batch.drop_constraint("uq_wallet_account_user_bucket", type_="unique")
        batch.create_unique_constraint("uq_wallet_account_user_id", ["user_id"])
    for table in ("usage_charge", "payment_order", "wallet_ledger", "wallet_account"):
        with op.batch_alter_table(table) as batch:
            batch.drop_constraint(f"ck_{table}_credit_bucket", type_="check")
            batch.drop_column("credit_bucket")
