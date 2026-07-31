from typing import Optional
from datetime import datetime
from decimal import Decimal
from uuid import uuid4
from .time_utils import utc_now
from sqlmodel import SQLModel, Field
from sqlalchemy import BigInteger, Boolean, CheckConstraint, Column, DateTime, Index, Integer, Numeric, String, Text, UniqueConstraint


# --------------------
# User
# --------------------
class User(SQLModel, table=True):
    __tablename__ = "user"

    id: Optional[int] = Field(default=None, primary_key=True)

    firebase_uid: Optional[str] = Field(default=None, index=True, unique=True)
    email: Optional[str] = Field(default=None, index=True, unique=True)

    name: str
    place: Optional[str] = None
    timezone: str = "Asia/Kolkata"
    assistant_name: str = "Elli"
    reply_language: str = "ta"

    created_at: datetime = Field(default_factory=utc_now)


# --------------------
# Email OTP codes (signup / password reset)
# --------------------
class EmailOtpCode(SQLModel, table=True):
    __tablename__ = "email_otp_code"

    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(index=True)
    purpose: str = Field(index=True)
    otp_hash: str
    created_at: datetime = Field(
        default_factory=utc_now,
        sa_column=Column(DateTime(timezone=True), nullable=False, index=True),
    )
    expires_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, index=True)
    )
    consumed_at: Optional[datetime] = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True), nullable=True, index=True),
    )
    attempts: int = Field(default=0)
    last_sent_at: datetime = Field(
        default_factory=utc_now,
        sa_column=Column(DateTime(timezone=True), nullable=False, index=True),
    )


# --------------------
# Item (core memory / notes / tasks / reminders)
# --------------------
class Item(SQLModel, table=True):
    __tablename__ = "item"

    id: Optional[int] = Field(default=None, primary_key=True)

    intent: str
    category: str
    raw_text: str

    transcript: Optional[str] = None
    datetime_str: Optional[str] = None
    title: Optional[str] = None
    details: Optional[str] = None

    source: str = "text"  # text | voice | system

    user_id: Optional[int] = Field(
        default=None,
        index=True,
        foreign_key="user.id",
    )

    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


# --------------------
# Conversation logs (LLM memory / audit)
# --------------------
class Conversation(SQLModel, table=True):
    __tablename__ = "conversation"

    id: Optional[int] = Field(default=None, primary_key=True)

    user_id: Optional[int] = Field(
        default=None,
        index=True,
        foreign_key="user.id",
    )

    channel: str  # "text" | "voice" | "search" | "system"
    user_input: str

    transcript: Optional[str] = None
    llm_output_json: Optional[str] = None

    created_at: datetime = Field(default_factory=utc_now)


# --------------------
# QA Cache (fast RAG / repetition memory)
# --------------------
class QACache(SQLModel, table=True):
    __tablename__ = "qa_cache"

    id: Optional[int] = Field(default=None, primary_key=True)

    user_id: Optional[int] = Field(
        default=None,
        index=True,
        foreign_key="user.id",
    )

    question: str
    answer: str

    hits: int = Field(default=1)
    updated_at: datetime = Field(default_factory=utc_now)


# --------------------
# Global QA Cache (cross-user approved repeated knowledge)
# --------------------
class GlobalQACache(SQLModel, table=True):
    __tablename__ = "global_qa_cache"

    id: Optional[int] = Field(default=None, primary_key=True)

    canonical_question: str
    normalized_question: str = Field(index=True)
    answer: str
    answer_language: str = Field(default="en", index=True)
    topic: Optional[str] = Field(default=None, index=True)

    scope: str = Field(default="global", index=True)  # global | user
    user_id_hash: Optional[str] = Field(default=None, index=True)
    status: str = Field(default="candidate", index=True)  # candidate | approved | rejected
    hit_count: int = Field(default=1, index=True)
    distinct_user_count: int = Field(default=1, index=True)
    observed_question_count: int = Field(default=1)
    source_question_hashes_json: str = Field(default="[]")
    observed_safe_questions_json: str = Field(default="[]")
    aliases_json: str = Field(default="[]")
    answer_hash: str = Field(index=True)

    embedding_json: Optional[str] = None
    embedding_kind: str = Field(default="token_hash_v1", index=True)
    embedding_norm: float = Field(default=0.0)
    token_hash_embedding_json: Optional[str] = None
    token_hash_embedding_norm: float = Field(default=0.0)
    real_embedding_json: Optional[str] = None
    real_embedding_norm: float = Field(default=0.0)
    real_embedding_kind: Optional[str] = Field(default=None, index=True)
    confidence: float = Field(default=0.0)
    safety_label: str = Field(default="general", index=True)
    model_used: Optional[str] = Field(default=None, index=True)

    first_seen_at: datetime = Field(default_factory=utc_now, index=True)
    last_seen_at: datetime = Field(default_factory=utc_now, index=True)
    expires_at: Optional[datetime] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now, index=True)
    reviewed_at: Optional[datetime] = None
    review_notes: Optional[str] = None


class GlobalQATombstone(SQLModel, table=True):
    __tablename__ = "global_qa_tombstone"

    id: Optional[int] = Field(default=None, primary_key=True)
    global_cache_id: int = Field(index=True)
    deleted_at: datetime = Field(default_factory=utc_now, index=True)
    reason: Optional[str] = None


class GlobalQAObservation(SQLModel, table=True):
    __tablename__ = "global_qa_observation"

    id: Optional[int] = Field(default=None, primary_key=True)
    global_cache_id: int = Field(index=True, foreign_key="global_qa_cache.id")
    user_id_hash: str = Field(index=True)
    question_hash: str = Field(index=True)
    normalized_question: str
    similarity_score: float = Field(default=0.0, index=True)
    answer_similarity_score: float = Field(default=1.0, index=True)
    backend_answer_hash: str = Field(index=True)
    conflicting_answer_hashes_json: str = Field(default="[]")
    model_used: Optional[str] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now, index=True)


class OpenAIUsageLog(SQLModel, table=True):
    __tablename__ = "openai_usage_log"

    id: Optional[int] = Field(default=None, primary_key=True)
    request_id: Optional[str] = Field(default=None, index=True)
    user_id_hash: Optional[str] = Field(default=None, index=True)
    route: str = Field(index=True)
    model_used: str = Field(index=True)
    model_tier: str = Field(index=True)
    reason: Optional[str] = None
    estimated_input_tokens: int = Field(default=0)
    estimated_output_tokens: int = Field(default=0)
    estimated_cost_usd: float = Field(default=0.0)
    actual_input_tokens: Optional[int] = Field(default=None)
    actual_output_tokens: Optional[int] = Field(default=None)
    actual_cost_usd: Optional[float] = Field(default=None)
    cache_hit: bool = Field(default=False, index=True)
    created_at: datetime = Field(default_factory=utc_now, index=True)


class AIUsageEvent(SQLModel, table=True):
    __tablename__ = "ai_usage_events"

    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=utc_now, index=True)
    request_id: Optional[str] = Field(default=None)
    user_id_hash: Optional[str] = Field(default=None, index=True)
    provider: str = Field(index=True)
    model: Optional[str] = Field(default=None, index=True)
    route: str = Field(index=True)
    intent: str = Field(index=True)
    language: str = Field(index=True)
    input_tokens: int = Field(default=0)
    output_tokens: int = Field(default=0)
    audio_seconds: float = Field(default=0.0)
    characters: int = Field(default=0)
    estimated_cost_amount: float = Field(default=0.0)
    estimated_cost_currency: str = Field(default="")
    cache_hit: bool = Field(default=False, index=True)
    cache_hit_source: Optional[str] = Field(default=None, index=True)
    latency_ms: Optional[int] = Field(default=None)
    metadata_json: str = Field(default="{}")


# --------------------
# Web application billing and chat
# --------------------
def _public_id() -> str:
    return str(uuid4())


class WalletAccount(SQLModel, table=True):
    __tablename__ = "wallet_account"
    __table_args__ = (
        UniqueConstraint("user_id", "credit_bucket", name="uq_wallet_account_user_bucket"),
        CheckConstraint("credit_bucket IN ('chat', 'voice')", name="ck_wallet_account_credit_bucket"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="RESTRICT", index=True)
    credit_bucket: str = Field(default="chat", max_length=16, sa_column=Column(String(16), nullable=False, server_default="chat"))
    balance_micros: int = Field(default=0, sa_column=Column(BigInteger, nullable=False, server_default="0"))
    reserved_micros: int = Field(default=0, sa_column=Column(BigInteger, nullable=False, server_default="0"))
    version: int = Field(default=0)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class WalletLedger(SQLModel, table=True):
    __tablename__ = "wallet_ledger"
    __table_args__ = (
        Index("ix_wallet_ledger_user_created", "user_id", "created_at"),
        Index("ix_wallet_ledger_user_bucket_created", "user_id", "credit_bucket", "created_at"),
        Index("ix_wallet_ledger_reference", "reference_type", "reference_id"),
        CheckConstraint("credit_bucket IN ('chat', 'voice')", name="ck_wallet_ledger_credit_bucket"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="RESTRICT", index=True)
    credit_bucket: str = Field(default="chat", max_length=16, sa_column=Column(String(16), nullable=False, server_default="chat"))
    entry_type: str = Field(max_length=32, index=True)
    amount_micros: int = Field(sa_column=Column(BigInteger, nullable=False))
    balance_after_micros: int = Field(sa_column=Column(BigInteger, nullable=False))
    reference_type: str = Field(max_length=48)
    reference_id: str = Field(max_length=128)
    idempotency_key: str = Field(unique=True, max_length=200)
    metadata_json: str = Field(default="{}", sa_column=Column(Text, nullable=False, server_default="{}"))
    created_at: datetime = Field(default_factory=utc_now, index=True)


class PaymentOrder(SQLModel, table=True):
    __tablename__ = "payment_order"
    __table_args__ = (
        Index("ix_payment_order_user_created", "user_id", "created_at"),
        CheckConstraint("credit_bucket IN ('chat', 'voice')", name="ck_payment_order_credit_bucket"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="RESTRICT", index=True)
    credit_bucket: str = Field(default="chat", max_length=16, sa_column=Column(String(16), nullable=False, server_default="chat"))
    provider: str = Field(default="razorpay", max_length=24)
    provider_order_id: Optional[str] = Field(default=None, unique=True, max_length=80)
    provider_payment_id: Optional[str] = Field(default=None, unique=True, max_length=80)
    receipt: str = Field(unique=True, max_length=40)
    gross_amount_paise: int
    credited_amount_micros: int = Field(sa_column=Column(BigInteger, nullable=False))
    platform_share_paise: int
    refunded_amount_paise: int = Field(default=0)
    status: str = Field(default="creating", max_length=32, index=True)
    checkout_signature: Optional[str] = Field(default=None, max_length=256)
    metadata_json: str = Field(default="{}", sa_column=Column(Text, nullable=False, server_default="{}"))
    created_at: datetime = Field(default_factory=utc_now, index=True)
    paid_at: Optional[datetime] = None
    refunded_at: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class ProcessedWebhook(SQLModel, table=True):
    __tablename__ = "processed_webhook"
    __table_args__ = (
        UniqueConstraint("event_id", name="uq_processed_webhook_event_id"),
        UniqueConstraint("provider", "event_id", name="uq_processed_webhook_provider_event"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    provider: str = Field(max_length=24, index=True)
    event_id: str = Field(max_length=160, index=True)
    event_type: str = Field(max_length=80, index=True)
    payload_sha256: str = Field(max_length=64)
    processed_at: datetime = Field(default_factory=utc_now, index=True)


class WebChatThread(SQLModel, table=True):
    __tablename__ = "web_chat_thread"
    __table_args__ = (Index("ix_web_chat_thread_user_updated", "user_id", "updated_at"),)

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    title: str = Field(default="New chat", max_length=120)
    archived_at: Optional[datetime] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class WebChatMessage(SQLModel, table=True):
    __tablename__ = "web_chat_message"
    __table_args__ = (
        Index("ix_web_chat_message_thread_created", "thread_id", "created_at"),
        UniqueConstraint("user_id", "request_id", "role", name="uq_web_message_user_request_role"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    thread_id: str = Field(foreign_key="web_chat_thread.id", ondelete="CASCADE", index=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    role: str = Field(max_length=16, index=True)
    content: str = Field(sa_column=Column(Text, nullable=False))
    request_id: Optional[str] = Field(default=None, max_length=64, index=True)
    provider: Optional[str] = Field(default=None, max_length=24)
    model: Optional[str] = Field(default=None, max_length=100)
    swico_tier: Optional[str] = Field(default=None, max_length=16, index=True)
    input_tokens: int = Field(default=0)
    output_tokens: int = Field(default=0)
    usage_source: Optional[str] = Field(default=None, max_length=16)
    charge_micros: int = Field(default=0, sa_column=Column(BigInteger, nullable=False, server_default="0"))
    status: str = Field(default="complete", max_length=24, index=True)
    metadata_json: str = Field(default="{}", sa_column=Column(Text, nullable=False, server_default="{}"))
    replaces_message_id: Optional[str] = Field(
        default=None, foreign_key="web_chat_message.id", ondelete="SET NULL",
        index=True, max_length=36,
    )
    revision_number: int = Field(
        default=1, sa_column=Column(Integer, nullable=False, server_default="1")
    )
    superseded_at: Optional[datetime] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now, index=True)


class WebMemoryFact(SQLModel, table=True):
    __tablename__ = "web_memory_fact"
    __table_args__ = (
        Index("ix_web_memory_fact_user_updated", "user_id", "updated_at"),
        UniqueConstraint("user_id", "normalized_key", name="uq_web_memory_fact_user_key"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    normalized_key: str = Field(max_length=160)
    value_text: str = Field(sa_column=Column(Text, nullable=False))
    category: str = Field(default="preference", max_length=40, index=True)
    salience: float = Field(default=0.5)
    confidence: float = Field(default=1.0)
    embedding_json: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    embedding_norm: float = Field(default=0.0)
    source_thread_id: Optional[str] = Field(
        default=None, foreign_key="web_chat_thread.id", ondelete="SET NULL", index=True,
        max_length=36,
    )
    source_message_id: Optional[str] = Field(
        default=None, foreign_key="web_chat_message.id", ondelete="SET NULL", index=True,
        max_length=36,
    )
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now, index=True)
    accessed_at: datetime = Field(default_factory=utc_now, index=True)
    deleted_at: Optional[datetime] = Field(default=None, index=True)


class WebMessageFeedback(SQLModel, table=True):
    __tablename__ = "web_message_feedback"
    __table_args__ = (
        UniqueConstraint("user_id", "message_id", name="uq_web_message_feedback_user_message"),
        Index("ix_web_message_feedback_user_updated", "user_id", "updated_at"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    message_id: str = Field(
        foreign_key="web_chat_message.id", ondelete="CASCADE", index=True, max_length=36
    )
    rating: str = Field(max_length=8, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class WebConversationSummary(SQLModel, table=True):
    __tablename__ = "web_conversation_summary"
    __table_args__ = (
        UniqueConstraint("user_id", "thread_id", name="uq_web_conversation_summary_user_thread"),
        Index("ix_web_conversation_summary_user_updated", "user_id", "updated_at"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    thread_id: str = Field(
        foreign_key="web_chat_thread.id", ondelete="CASCADE", index=True, max_length=36,
    )
    summary_text: str = Field(sa_column=Column(Text, nullable=False))
    keywords_text: str = Field(default="", sa_column=Column(Text, nullable=False, server_default=""))
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class UsageCharge(SQLModel, table=True):
    __tablename__ = "usage_charge"
    __table_args__ = (
        Index("ix_usage_charge_user_created", "user_id", "created_at"),
        Index("ix_usage_charge_user_kind_settled", "user_id", "usage_kind", "settled_at"),
        UniqueConstraint("request_id", name="uq_usage_charge_request_id"),
        CheckConstraint("credit_bucket IN ('chat', 'voice')", name="ck_usage_charge_credit_bucket"),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    request_id: str = Field(max_length=64, index=True)
    user_id: int = Field(foreign_key="user.id", ondelete="RESTRICT", index=True)
    credit_bucket: str = Field(default="chat", max_length=16, sa_column=Column(String(16), nullable=False, server_default="chat"))
    thread_id: Optional[str] = Field(default=None, foreign_key="web_chat_thread.id", ondelete="SET NULL", index=True, max_length=36)
    assistant_message_id: Optional[str] = Field(default=None, foreign_key="web_chat_message.id", ondelete="SET NULL", max_length=36)
    usage_kind: str = Field(default="chat", max_length=16, sa_column=Column(String(16), nullable=False, server_default="chat"))
    voice_turn_id: Optional[str] = Field(default=None, index=True, max_length=36)
    audio_milliseconds: int = Field(default=0, sa_column=Column(BigInteger, nullable=False, server_default="0"))
    characters: int = Field(default=0, sa_column=Column(Integer, nullable=False, server_default="0"))
    provider: str = Field(max_length=24)
    model: str = Field(max_length=100)
    swico_tier: Optional[str] = Field(default=None, max_length=16, index=True)
    input_tokens: int = Field(default=0)
    cached_input_tokens: int = Field(default=0)
    output_tokens: int = Field(default=0)
    usage_source: str = Field(default="estimated", max_length=16)
    provider_cost_amount_decimal: Decimal = Field(default=Decimal("0"), sa_column=Column(Numeric(24, 12), nullable=False, server_default="0"))
    provider_cost_currency: str = Field(default="INR", max_length=8)
    usd_to_inr_rate: Optional[Decimal] = Field(default=None, sa_column=Column(Numeric(18, 8), nullable=True))
    provider_cost_micros: int = Field(default=0, sa_column=Column(BigInteger, nullable=False, server_default="0"))
    reserved_micros: int = Field(default=0, sa_column=Column(BigInteger, nullable=False, server_default="0"))
    debited_micros: int = Field(default=0, sa_column=Column(BigInteger, nullable=False, server_default="0"))
    billing_exemption_reason: Optional[str] = Field(default=None, max_length=64)
    status: str = Field(default="reserving", max_length=16, index=True)
    pricing_snapshot_json: str = Field(default="{}", sa_column=Column(Text, nullable=False, server_default="{}"))
    created_at: datetime = Field(default_factory=utc_now, index=True)
    settled_at: Optional[datetime] = None


class WebRetrievalTrace(SQLModel, table=True):
    """Content-free TRIAG planning/retrieval telemetry."""

    __tablename__ = "web_retrieval_trace"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_web_retrieval_trace_user_idempotency",
        ),
        Index(
            "ix_web_retrieval_trace_user_request",
            "user_id",
            "request_id",
        ),
        CheckConstraint(
            "status IN ('planned', 'running', 'complete', 'skipped', 'failed')",
            name="ck_web_retrieval_trace_status",
        ),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(
        foreign_key="user.id", ondelete="CASCADE", index=True
    )
    thread_id: Optional[str] = Field(
        default=None,
        foreign_key="web_chat_thread.id",
        ondelete="SET NULL",
        index=True,
        max_length=36,
    )
    request_id: str = Field(max_length=64, index=True)
    idempotency_key: str = Field(max_length=160)
    policy_version: str = Field(max_length=24)
    tier_id: str = Field(max_length=16)
    status: str = Field(default="planned", max_length=16, index=True)
    safe_metadata_json: str = Field(
        default="{}",
        sa_column=Column(Text, nullable=False, server_default="{}"),
    )
    created_at: datetime = Field(default_factory=utc_now, index=True)
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class WebEvidenceItem(SQLModel, table=True):
    """Evidence provenance only; excerpts and generated content are forbidden."""

    __tablename__ = "web_evidence_item"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_web_evidence_item_user_idempotency",
        ),
        UniqueConstraint(
            "trace_id",
            "ordinal",
            name="uq_web_evidence_item_trace_ordinal",
        ),
        Index(
            "ix_web_evidence_item_user_request",
            "user_id",
            "request_id",
        ),
        CheckConstraint(
            "status IN ('candidate', 'selected', 'rejected', 'consumed')",
            name="ck_web_evidence_item_status",
        ),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    trace_id: str = Field(
        foreign_key="web_retrieval_trace.id",
        ondelete="CASCADE",
        index=True,
        max_length=36,
    )
    user_id: int = Field(
        foreign_key="user.id", ondelete="CASCADE", index=True
    )
    request_id: str = Field(max_length=64, index=True)
    idempotency_key: str = Field(max_length=160)
    source_type: str = Field(max_length=32, index=True)
    source_id: str = Field(max_length=160)
    ordinal: int = Field(default=0)
    estimated_tokens: int = Field(default=0)
    status: str = Field(default="candidate", max_length=16, index=True)
    safe_metadata_json: str = Field(
        default="{}",
        sa_column=Column(Text, nullable=False, server_default="{}"),
    )
    created_at: datetime = Field(default_factory=utc_now, index=True)


class WebAnswerCheck(SQLModel, table=True):
    """Result metadata for future answer checks; no answer body is stored."""

    __tablename__ = "web_answer_check"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_web_answer_check_user_idempotency",
        ),
        Index(
            "ix_web_answer_check_user_request",
            "user_id",
            "request_id",
        ),
        CheckConstraint(
            "status IN ('not_run', 'passed', 'failed', 'skipped', 'error')",
            name="ck_web_answer_check_status",
        ),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(
        foreign_key="user.id", ondelete="CASCADE", index=True
    )
    thread_id: Optional[str] = Field(
        default=None,
        foreign_key="web_chat_thread.id",
        ondelete="SET NULL",
        index=True,
        max_length=36,
    )
    request_id: str = Field(max_length=64, index=True)
    assistant_message_id: Optional[str] = Field(
        default=None,
        foreign_key="web_chat_message.id",
        ondelete="SET NULL",
        index=True,
        max_length=36,
    )
    idempotency_key: str = Field(max_length=160)
    status: str = Field(default="not_run", max_length=16, index=True)
    passed: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default="false"),
    )
    safe_metadata_json: str = Field(
        default="{}",
        sa_column=Column(Text, nullable=False, server_default="{}"),
    )
    created_at: datetime = Field(default_factory=utc_now, index=True)
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class WebUsageStage(SQLModel, table=True):
    """Idempotent future stage accounting; UsageCharge stays authoritative."""

    __tablename__ = "web_usage_stage"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "idempotency_key",
            name="uq_web_usage_stage_user_idempotency",
        ),
        UniqueConstraint(
            "user_id",
            "request_id",
            "stage_name",
            name="uq_web_usage_stage_user_request_stage",
        ),
        Index(
            "ix_web_usage_stage_user_request",
            "user_id",
            "request_id",
        ),
        CheckConstraint(
            "status IN ('planned', 'reserved', 'running', 'settled', 'released', 'skipped', 'failed')",
            name="ck_web_usage_stage_status",
        ),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(
        foreign_key="user.id", ondelete="CASCADE", index=True
    )
    thread_id: Optional[str] = Field(
        default=None,
        foreign_key="web_chat_thread.id",
        ondelete="SET NULL",
        index=True,
        max_length=36,
    )
    usage_charge_id: Optional[str] = Field(
        default=None,
        foreign_key="usage_charge.id",
        ondelete="SET NULL",
        index=True,
        max_length=36,
    )
    request_id: str = Field(max_length=64, index=True)
    idempotency_key: str = Field(max_length=160)
    stage_name: str = Field(max_length=32, index=True)
    stage_order: int = Field(default=0)
    status: str = Field(default="planned", max_length=16, index=True)
    reserved_micros: int = Field(
        default=0,
        sa_column=Column(BigInteger, nullable=False, server_default="0"),
    )
    debited_micros: int = Field(
        default=0,
        sa_column=Column(BigInteger, nullable=False, server_default="0"),
    )
    input_tokens: int = Field(default=0)
    output_tokens: int = Field(default=0)
    safe_metadata_json: str = Field(
        default="{}",
        sa_column=Column(Text, nullable=False, server_default="{}"),
    )
    created_at: datetime = Field(default_factory=utc_now, index=True)
    updated_at: datetime = Field(default_factory=utc_now, index=True)
    settled_at: Optional[datetime] = None


class WebUsagePreferences(SQLModel, table=True):
    __tablename__ = "web_usage_preferences"
    __table_args__ = (UniqueConstraint("user_id", name="uq_web_usage_preferences_user_id"),)

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    period: str = Field(default="monthly", max_length=16)
    assistant_tier: str = Field(default="lite", max_length=16)
    hard_limit_micros: Optional[int] = Field(
        default=None, sa_column=Column(BigInteger, nullable=True)
    )
    warning_threshold_percent: int = Field(default=80)
    notify_at_threshold: bool = Field(default=True)
    memory_enabled: bool = Field(
        default=False, sa_column=Column(Boolean, nullable=False, server_default="false")
    )
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class WebUsagePeriodLock(SQLModel, table=True):
    """Serialization row for a user's local-calendar monthly usage window.

    This row contains no financial totals. UsageCharge remains authoritative;
    locking this stable key makes the aggregate-and-reserve decision atomic.
    """

    __tablename__ = "web_usage_period_lock"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "period_start_utc", name="uq_web_usage_period_lock_user_start"
        ),
    )

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    period_start_utc: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False, index=True)
    )
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now, index=True)


class ApiRateLimit(SQLModel, table=True):
    __tablename__ = "api_rate_limit"
    __table_args__ = (UniqueConstraint("scope_key", "window_started_at", name="uq_api_rate_limit_scope_window"),)

    id: str = Field(default_factory=_public_id, primary_key=True, max_length=36)
    scope_key: str = Field(max_length=160, index=True)
    window_started_at: datetime = Field(index=True)
    request_count: int = Field(default=0)
    updated_at: datetime = Field(default_factory=utc_now)


class AgentRun(SQLModel, table=True):
    __tablename__ = "agent_run"

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, index=True)
    request_id: Optional[str] = Field(default=None, index=True)
    channel: str = Field(default="text", index=True)
    message_hash: str = Field(index=True)
    message_preview: str = ""
    final_route: str = Field(index=True)
    final_intent: str = Field(index=True)
    confidence: float = Field(default=0.0, index=True)
    provider_calls: int = Field(default=0)
    estimated_cost_amount: float = Field(default=0.0)
    estimated_cost_currency: str = ""
    metadata_json: str = Field(default="{}")
    created_at: datetime = Field(default_factory=utc_now, index=True)


class AgentStep(SQLModel, table=True):
    __tablename__ = "agent_step"

    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: int = Field(index=True, foreign_key="agent_run.id")
    step_name: str = Field(index=True)
    input_json: str = Field(default="{}")
    output_json: str = Field(default="{}")
    confidence: float = Field(default=0.0, index=True)
    duration_ms: int = Field(default=0)
    created_at: datetime = Field(default_factory=utc_now, index=True)


class DocumentArtifact(SQLModel, table=True):
    __tablename__ = "document_artifact"

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True, foreign_key="user.id")
    item_id: Optional[int] = Field(default=None, index=True, foreign_key="item.id")
    title: str = Field(index=True)
    format: str = Field(index=True)
    category: str = Field(default="Other", index=True)
    relative_path: str
    source_text: str = ""
    metadata_json: str = Field(default="{}")
    created_at: datetime = Field(default_factory=utc_now, index=True)


# --------------------
# Daily Routine (editable)
# --------------------
class DailyRoutine(SQLModel, table=True):
    __tablename__ = "daily_routine"

    id: Optional[int] = Field(default=None, primary_key=True)

    user_id: int = Field(
        foreign_key="user.id",
        unique=True,
    )

    wake_time: str
    sleep_time: str

    work_start: Optional[str] = None
    work_end: Optional[str] = None
    daily_habits: Optional[str] = None

    updated_at: datetime = Field(default_factory=utc_now)


# --------------------
# User Personality / Character Profile
# --------------------
class UserProfile(SQLModel, table=True):
    __tablename__ = "user_profile"

    id: Optional[int] = Field(default=None, primary_key=True)

    user_id: int = Field(
        foreign_key="user.id",
        ondelete="CASCADE",
        unique=True,
    )

    answers_json: str = Field(sa_column=Column(Text, nullable=False))
    questions_version: int = 1

    profile_summary: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    updated_at: datetime = Field(default_factory=utc_now)


# --------------------
# RAG Embeddings (persistent semantic index)
# --------------------
class RagEmbedding(SQLModel, table=True):
    __tablename__ = "rag_embedding"
    __table_args__ = (
        Index("ix_rag_embedding_content_hash_unique", "content_hash", unique=True),
        Index("ix_rag_embedding_user_source_updated", "user_id", "source_type", "updated_at"),
        Index("ix_rag_embedding_user_updated", "user_id", "updated_at"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, index=True, foreign_key="user.id")
    source_type: str = Field(index=True)
    source_id: str = Field(index=True)
    content_hash: str = Field(index=True)
    content_text: str
    embedding_json: str
    embedding_norm: float = 0.0
    updated_at: datetime = Field(default_factory=utc_now, index=True)


# --------------------
# Background Jobs
# --------------------
class Job(SQLModel, table=True):
    __tablename__ = "job"

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, index=True, foreign_key="user.id")

    job_type: str = Field(index=True)
    status: str = Field(default="queued", index=True)

    payload_json: str
    result_json: Optional[str] = None
    error_message: Optional[str] = None

    attempts: int = 0
    max_attempts: int = 3

    run_at: datetime = Field(default_factory=utc_now, index=True)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None

    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
