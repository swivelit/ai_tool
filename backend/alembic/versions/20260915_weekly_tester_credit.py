"""add backend-only weekly tester Chat credit windows"""

from alembic import op
import sqlalchemy as sa


revision = "20260915_weekly_tester_credit"
down_revision = "20260913_cli_reservations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "weekly_tester_credit_window",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("credit_bucket", sa.String(length=16), server_default="chat", nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("allowance_micros", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("reserved_micros", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("consumed_micros", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("version", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("credit_bucket = 'chat'", name="ck_tester_credit_chat_bucket"),
        sa.CheckConstraint(
            "allowance_micros >= 0 AND reserved_micros >= 0 AND consumed_micros >= 0 AND reserved_micros + consumed_micros <= allowance_micros",
            name="ck_tester_credit_nonnegative",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "credit_bucket", "period_start", name="uq_tester_credit_user_bucket_week"),
    )
    op.create_index("ix_weekly_tester_credit_window_user_id", "weekly_tester_credit_window", ["user_id"])
    op.create_index("ix_tester_credit_user_period", "weekly_tester_credit_window", ["user_id", "period_start", "period_end"])
    op.add_column(
        "usage_charge",
        sa.Column("tester_credit_window_id", sa.String(length=36), nullable=True),
    )
    with op.batch_alter_table("usage_charge") as batch:
        batch.create_foreign_key(
            "fk_usage_charge_tester_credit_window_id",
            "weekly_tester_credit_window",
            ["tester_credit_window_id"], ["id"], ondelete="SET NULL",
        )
        batch.drop_constraint("ck_usage_charge_funding_source", type_="check")
        batch.create_check_constraint(
            "ck_usage_charge_funding_source",
            "funding_source IN ('wallet', 'subscription', 'tester_credit', 'billing_exempt', 'free')",
        )
    op.create_index("ix_usage_charge_tester_credit_window_id", "usage_charge", ["tester_credit_window_id"])


def downgrade() -> None:
    with op.batch_alter_table("usage_charge") as batch:
        batch.drop_constraint("fk_usage_charge_tester_credit_window_id", type_="foreignkey")
        batch.drop_constraint("ck_usage_charge_funding_source", type_="check")
        batch.create_check_constraint(
            "ck_usage_charge_funding_source",
            "funding_source IN ('wallet', 'subscription', 'billing_exempt', 'free')",
        )
    op.drop_index("ix_usage_charge_tester_credit_window_id", table_name="usage_charge")
    op.drop_column("usage_charge", "tester_credit_window_id")
    op.drop_index("ix_tester_credit_user_period", table_name="weekly_tester_credit_window")
    op.drop_index("ix_weekly_tester_credit_window_user_id", table_name="weekly_tester_credit_window")
    op.drop_table("weekly_tester_credit_window")
