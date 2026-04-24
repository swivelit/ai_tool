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