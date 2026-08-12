"""add production web subscriptions and referral rewards

Revision ID: b8f2c7d1e4a9
Revises: 7b4c9e1a2d6f
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b8f2c7d1e4a9"
down_revision: Union[str, Sequence[str], None] = "7b4c9e1a2d6f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("payment_order") as batch:
        batch.add_column(sa.Column("purchase_type", sa.String(24), nullable=False, server_default="topup"))
        batch.add_column(sa.Column("subscription_plan_code", sa.String(8), nullable=True))
        batch.add_column(sa.Column("fulfillment_status", sa.String(32), nullable=False, server_default="pending"))
        batch.create_index("ix_payment_order_purchase_type", ["purchase_type"], unique=False)
        batch.create_index("ix_payment_order_subscription_plan_code", ["subscription_plan_code"], unique=False)
        batch.create_index("ix_payment_order_fulfillment_status", ["fulfillment_status"], unique=False)
        batch.create_check_constraint("ck_payment_order_purchase_type", "purchase_type IN ('topup', 'subscription')")
        batch.create_check_constraint("ck_payment_order_subscription_no_wallet_credit", "purchase_type <> 'subscription' OR credited_amount_micros = 0")

    op.create_table(
        "subscription_entitlement",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("credit_bucket", sa.String(16), nullable=False),
        sa.Column("source", sa.String(24), nullable=False),
        sa.Column("plan_code", sa.String(8), nullable=False),
        sa.Column("source_payment_order_id", sa.String(36), sa.ForeignKey("payment_order.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("source_referral_reward_id", sa.String(36), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("weekly_allowance_micros", sa.BigInteger(), nullable=False),
        sa.Column("price_paise", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("duration_months", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reward_weeks", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rule_snapshot_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source_payment_order_id", name="uq_subscription_entitlement_payment"),
        sa.UniqueConstraint("source_referral_reward_id", name="uq_subscription_entitlement_reward"),
        sa.CheckConstraint("credit_bucket IN ('chat', 'voice')", name="ck_subscription_entitlement_bucket"),
        sa.CheckConstraint("source IN ('purchase', 'referral_reward')", name="ck_subscription_entitlement_source"),
        sa.CheckConstraint("status IN ('queued', 'active', 'expired', 'cancelled')", name="ck_subscription_entitlement_status"),
        sa.CheckConstraint("ends_at > starts_at", name="ck_subscription_entitlement_dates"),
        sa.CheckConstraint("weekly_allowance_micros >= 0", name="ck_subscription_entitlement_allowance"),
        sa.CheckConstraint("price_paise >= 0 AND duration_months >= 0", name="ck_subscription_entitlement_snapshot"),
    )
    op.create_index("ix_subscription_entitlement_user_id", "subscription_entitlement", ["user_id"])
    op.create_index("ix_subscription_entitlement_credit_bucket", "subscription_entitlement", ["credit_bucket"])
    op.create_index("ix_subscription_entitlement_source_payment_order_id", "subscription_entitlement", ["source_payment_order_id"])
    op.create_index("ix_subscription_entitlement_source_referral_reward_id", "subscription_entitlement", ["source_referral_reward_id"])
    op.create_index("ix_subscription_entitlement_starts_at", "subscription_entitlement", ["starts_at"])
    op.create_index("ix_subscription_entitlement_ends_at", "subscription_entitlement", ["ends_at"])
    op.create_index("ix_subscription_entitlement_status", "subscription_entitlement", ["status"])
    op.create_index("ix_subscription_entitlement_user_bucket_start", "subscription_entitlement", ["user_id", "credit_bucket", "starts_at"])

    op.create_table(
        "referral_code",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("disabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("code", name="uq_referral_code_code"),
        sa.UniqueConstraint("user_id", name="uq_referral_code_user"),
    )
    op.create_index("ix_referral_code_user_id", "referral_code", ["user_id"])
    op.create_index("ix_referral_code_code", "referral_code", ["code"])
    op.create_index("ix_referral_code_disabled", "referral_code", ["disabled"])

    op.create_table(
        "referral_attribution",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("referrer_user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("referred_user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("referral_code_id", sa.String(36), sa.ForeignKey("referral_code.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="claimed"),
        sa.UniqueConstraint("referred_user_id", name="uq_referral_attribution_referred"),
        sa.CheckConstraint("referrer_user_id <> referred_user_id", name="ck_referral_attribution_not_self"),
        sa.CheckConstraint("status IN ('claimed', 'disabled')", name="ck_referral_attribution_status"),
    )
    for name, column in (("referrer_user_id", "referrer_user_id"), ("referred_user_id", "referred_user_id"), ("referral_code_id", "referral_code_id"), ("claimed_at", "claimed_at"), ("status", "status")):
        op.create_index(f"ix_referral_attribution_{name}", "referral_attribution", [column])

    op.create_table(
        "referral_reward",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("referrer_user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("referred_user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("qualifying_payment_order_id", sa.String(36), sa.ForeignKey("payment_order.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("credit_bucket", sa.String(16), nullable=False),
        sa.Column("purchased_plan_code", sa.String(8), nullable=False),
        sa.Column("purchased_price_paise", sa.BigInteger(), nullable=False),
        sa.Column("reward_duration_months", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reward_duration_weeks", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("generated_entitlement_id", sa.String(36), sa.ForeignKey("subscription_entitlement.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("status", sa.String(24), nullable=False, server_default="pending"),
        sa.Column("manual_review_required", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("qualifying_payment_order_id", name="uq_referral_reward_qualifying_order"),
        sa.CheckConstraint("credit_bucket IN ('chat', 'voice')", name="ck_referral_reward_bucket"),
    )
    for name in ("referrer_user_id", "referred_user_id", "qualifying_payment_order_id", "generated_entitlement_id", "status", "created_at"):
        op.create_index(f"ix_referral_reward_{name}", "referral_reward", [name])
    op.create_index("ix_referral_reward_referrer_status", "referral_reward", ["referrer_user_id", "status"])

    # The reward table is created after entitlements so this completes the
    # bidirectional audit relationship without relying on metadata-only links.
    with op.batch_alter_table("subscription_entitlement") as batch:
        batch.create_foreign_key(
            "fk_subscription_entitlement_source_referral_reward",
            "referral_reward", ["source_referral_reward_id"], ["id"], ondelete="RESTRICT",
        )

    op.create_table(
        "subscription_usage_window",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("entitlement_id", sa.String(36), sa.ForeignKey("subscription_entitlement.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("credit_bucket", sa.String(16), nullable=False),
        sa.Column("window_index", sa.Integer(), nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("allowance_micros", sa.BigInteger(), nullable=False),
        sa.Column("reserved_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("consumed_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("entitlement_id", "window_index", name="uq_subscription_window_entitlement_index"),
        sa.CheckConstraint("allowance_micros >= 0 AND reserved_micros >= 0 AND consumed_micros >= 0", name="ck_subscription_window_non_negative"),
        sa.CheckConstraint("credit_bucket IN ('chat', 'voice')", name="ck_subscription_window_bucket"),
        sa.CheckConstraint("reserved_micros + consumed_micros <= allowance_micros", name="ck_subscription_window_not_overdrawn"),
        sa.CheckConstraint("period_end > period_start", name="ck_subscription_window_dates"),
    )
    for name in ("entitlement_id", "user_id", "period_start", "period_end", "updated_at"):
        op.create_index(f"ix_subscription_usage_window_{name}", "subscription_usage_window", [name])
    op.create_index("ix_subscription_window_user_bucket_period", "subscription_usage_window", ["user_id", "credit_bucket", "period_start", "period_end"])

    op.create_table(
        "subscription_preference",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("credit_bucket", sa.String(16), nullable=False),
        sa.Column("payg_fallback_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "credit_bucket", name="uq_subscription_preference_user_bucket"),
    )
    op.create_index("ix_subscription_preference_user_id", "subscription_preference", ["user_id"])

    with op.batch_alter_table("usage_charge") as batch:
        batch.add_column(sa.Column("funding_source", sa.String(24), nullable=False, server_default="wallet"))
        batch.add_column(sa.Column("subscription_window_id", sa.String(36), nullable=True))
        batch.create_index("ix_usage_charge_funding_source", ["funding_source"], unique=False)
        batch.create_index("ix_usage_charge_subscription_window_id", ["subscription_window_id"], unique=False)
        batch.create_check_constraint(
            "ck_usage_charge_funding_source",
            "funding_source IN ('wallet', 'subscription', 'billing_exempt', 'free')",
        )

    op.create_table(
        "subscription_usage_ledger",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("credit_bucket", sa.String(16), nullable=False),
        sa.Column("entitlement_id", sa.String(36), sa.ForeignKey("subscription_entitlement.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("window_id", sa.String(36), sa.ForeignKey("subscription_usage_window.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("usage_charge_id", sa.String(36), sa.ForeignKey("usage_charge.id", ondelete="SET NULL"), nullable=True),
        sa.Column("entry_type", sa.String(24), nullable=False),
        sa.Column("amount_micros", sa.BigInteger(), nullable=False),
        sa.Column("idempotency_key", sa.String(200), nullable=False),
        sa.Column("metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("idempotency_key", name="uq_subscription_usage_ledger_idempotency"),
        sa.CheckConstraint("entry_type IN ('reservation', 'reservation_release', 'usage_debit')", name="ck_subscription_usage_ledger_type"),
        sa.CheckConstraint("amount_micros >= 0", name="ck_subscription_usage_ledger_amount"),
        sa.CheckConstraint("credit_bucket IN ('chat', 'voice')", name="ck_subscription_usage_ledger_bucket"),
    )
    for name in ("user_id", "entitlement_id", "window_id", "usage_charge_id", "created_at"):
        op.create_index(f"ix_subscription_usage_ledger_{name}", "subscription_usage_ledger", [name])
    op.create_index("ix_subscription_usage_ledger_user_created", "subscription_usage_ledger", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_table("subscription_usage_ledger")
    with op.batch_alter_table("usage_charge") as batch:
        batch.drop_constraint("ck_usage_charge_funding_source", type_="check")
        batch.drop_index("ix_usage_charge_subscription_window_id")
        batch.drop_index("ix_usage_charge_funding_source")
        batch.drop_column("subscription_window_id")
        batch.drop_column("funding_source")
    op.drop_table("subscription_preference")
    op.drop_table("subscription_usage_window")
    with op.batch_alter_table("subscription_entitlement") as batch:
        batch.drop_constraint("fk_subscription_entitlement_source_referral_reward", type_="foreignkey")
    op.drop_table("referral_reward")
    op.drop_table("referral_attribution")
    op.drop_table("referral_code")
    op.drop_table("subscription_entitlement")
    with op.batch_alter_table("payment_order") as batch:
        batch.drop_constraint("ck_payment_order_subscription_no_wallet_credit", type_="check")
        batch.drop_constraint("ck_payment_order_purchase_type", type_="check")
        batch.drop_index("ix_payment_order_fulfillment_status")
        batch.drop_index("ix_payment_order_subscription_plan_code")
        batch.drop_index("ix_payment_order_purchase_type")
        batch.drop_column("fulfillment_status")
        batch.drop_column("subscription_plan_code")
        batch.drop_column("purchase_type")
