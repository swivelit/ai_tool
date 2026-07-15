"""add prepaid web billing and chat tables

Revision ID: 6d4f2a9c8b71
Revises: a4c9e2f7b1d3
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "6d4f2a9c8b71"
down_revision: Union[str, Sequence[str], None] = "a4c9e2f7b1d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "wallet_account",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("balance_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("reserved_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", name="uq_wallet_account_user_id"),
        sa.CheckConstraint("reserved_micros >= 0", name="ck_wallet_reserved_nonnegative"),
    )
    op.create_index("ix_wallet_account_user_id", "wallet_account", ["user_id"])
    op.create_index("ix_wallet_account_updated_at", "wallet_account", ["updated_at"])

    op.create_table(
        "wallet_ledger",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("entry_type", sa.String(32), nullable=False),
        sa.Column("amount_micros", sa.BigInteger(), nullable=False),
        sa.Column("balance_after_micros", sa.BigInteger(), nullable=False),
        sa.Column("reference_type", sa.String(48), nullable=False),
        sa.Column("reference_id", sa.String(128), nullable=False),
        sa.Column("idempotency_key", sa.String(200), nullable=False, unique=True),
        sa.Column("metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("entry_type IN ('payment_credit','usage_debit','reservation','reservation_release','refund_debit','manual_adjustment')", name="ck_wallet_ledger_entry_type"),
    )
    op.create_index("ix_wallet_ledger_user_id", "wallet_ledger", ["user_id"])
    op.create_index("ix_wallet_ledger_entry_type", "wallet_ledger", ["entry_type"])
    op.create_index("ix_wallet_ledger_created_at", "wallet_ledger", ["created_at"])
    op.create_index("ix_wallet_ledger_user_created", "wallet_ledger", ["user_id", "created_at"])
    op.create_index("ix_wallet_ledger_reference", "wallet_ledger", ["reference_type", "reference_id"])

    op.create_table(
        "payment_order",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("provider", sa.String(24), nullable=False, server_default="razorpay"),
        sa.Column("provider_order_id", sa.String(80), unique=True),
        sa.Column("provider_payment_id", sa.String(80), unique=True),
        sa.Column("receipt", sa.String(40), nullable=False, unique=True),
        sa.Column("gross_amount_paise", sa.Integer(), nullable=False),
        sa.Column("credited_amount_micros", sa.BigInteger(), nullable=False),
        sa.Column("platform_share_paise", sa.Integer(), nullable=False),
        sa.Column("refunded_amount_paise", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(32), nullable=False, server_default="creating"),
        sa.Column("checkout_signature", sa.String(256)),
        sa.Column("metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("paid_at", sa.DateTime()),
        sa.Column("refunded_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("gross_amount_paise > 0", name="ck_payment_order_gross_positive"),
    )
    op.create_index("ix_payment_order_user_id", "payment_order", ["user_id"])
    op.create_index("ix_payment_order_status", "payment_order", ["status"])
    op.create_index("ix_payment_order_created_at", "payment_order", ["created_at"])
    op.create_index("ix_payment_order_updated_at", "payment_order", ["updated_at"])
    op.create_index("ix_payment_order_user_created", "payment_order", ["user_id", "created_at"])

    op.create_table(
        "processed_webhook",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("provider", sa.String(24), nullable=False),
        sa.Column("event_id", sa.String(160), nullable=False),
        sa.Column("event_type", sa.String(80), nullable=False),
        sa.Column("payload_sha256", sa.String(64), nullable=False),
        sa.Column("processed_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("event_id", name="uq_processed_webhook_event_id"),
        sa.UniqueConstraint("provider", "event_id", name="uq_processed_webhook_provider_event"),
    )
    for name in ("provider", "event_id", "event_type", "processed_at"):
        op.create_index(f"ix_processed_webhook_{name}", "processed_webhook", [name])

    op.create_table(
        "web_chat_thread",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(120), nullable=False, server_default="New chat"),
        sa.Column("archived_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    for name in ("user_id", "archived_at", "updated_at"):
        op.create_index(f"ix_web_chat_thread_{name}", "web_chat_thread", [name])
    op.create_index("ix_web_chat_thread_user_updated", "web_chat_thread", ["user_id", "updated_at"])

    op.create_table(
        "web_chat_message",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("thread_id", sa.String(36), sa.ForeignKey("web_chat_thread.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("request_id", sa.String(64)),
        sa.Column("provider", sa.String(24)),
        sa.Column("model", sa.String(100)),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("usage_source", sa.String(16)),
        sa.Column("charge_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(24), nullable=False, server_default="complete"),
        sa.Column("metadata_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "request_id", "role", name="uq_web_message_user_request_role"),
        sa.CheckConstraint("role IN ('user','assistant','system')", name="ck_web_chat_message_role"),
    )
    for name in ("thread_id", "user_id", "role", "request_id", "status", "created_at"):
        op.create_index(f"ix_web_chat_message_{name}", "web_chat_message", [name])
    op.create_index("ix_web_chat_message_thread_created", "web_chat_message", ["thread_id", "created_at"])

    op.create_table(
        "usage_charge",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("user.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("thread_id", sa.String(36), sa.ForeignKey("web_chat_thread.id", ondelete="SET NULL")),
        sa.Column("assistant_message_id", sa.String(36), sa.ForeignKey("web_chat_message.id", ondelete="SET NULL")),
        sa.Column("provider", sa.String(24), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("usage_source", sa.String(16), nullable=False, server_default="estimated"),
        sa.Column("provider_cost_amount_decimal", sa.Numeric(24, 12), nullable=False, server_default="0"),
        sa.Column("provider_cost_currency", sa.String(8), nullable=False, server_default="INR"),
        sa.Column("usd_to_inr_rate", sa.Numeric(18, 8)),
        sa.Column("provider_cost_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("reserved_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("debited_micros", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="reserving"),
        sa.Column("pricing_snapshot_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("settled_at", sa.DateTime()),
        sa.UniqueConstraint("request_id", name="uq_usage_charge_request_id"),
    )
    for name in ("request_id", "user_id", "thread_id", "status", "created_at"):
        op.create_index(f"ix_usage_charge_{name}", "usage_charge", [name])
    op.create_index("ix_usage_charge_user_created", "usage_charge", ["user_id", "created_at"])

    op.create_table(
        "api_rate_limit",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("scope_key", sa.String(160), nullable=False),
        sa.Column("window_started_at", sa.DateTime(), nullable=False),
        sa.Column("request_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("scope_key", "window_started_at", name="uq_api_rate_limit_scope_window"),
    )
    op.create_index("ix_api_rate_limit_scope_key", "api_rate_limit", ["scope_key"])
    op.create_index("ix_api_rate_limit_window_started_at", "api_rate_limit", ["window_started_at"])


def downgrade() -> None:
    op.drop_table("api_rate_limit")
    op.drop_table("usage_charge")
    op.drop_table("web_chat_message")
    op.drop_table("web_chat_thread")
    op.drop_table("processed_webhook")
    op.drop_table("payment_order")
    op.drop_table("wallet_ledger")
    op.drop_table("wallet_account")
