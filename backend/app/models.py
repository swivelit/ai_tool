from typing import Optional
from datetime import datetime
from .time_utils import utc_now
from sqlmodel import SQLModel, Field


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
    request_id: Optional[str] = Field(default=None, index=True)
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
    latency_ms: Optional[int] = Field(default=None)
    metadata_json: str = Field(default="{}")


# --------------------
# Daily Routine (editable)
# --------------------
class DailyRoutine(SQLModel, table=True):
    __tablename__ = "daily_routine"

    id: Optional[int] = Field(default=None, primary_key=True)

    user_id: int = Field(
        index=True,
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
        index=True,
        foreign_key="user.id",
        unique=True,
    )

    answers_json: str
    questions_version: int = 1

    profile_summary: Optional[str] = None
    updated_at: datetime = Field(default_factory=utc_now)


# --------------------
# RAG Embeddings (persistent semantic index)
# --------------------
class RagEmbedding(SQLModel, table=True):
    __tablename__ = "rag_embedding"

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
