from typing import Optional
from datetime import datetime
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
    assistant_name: str = "Ellie"
    reply_language: str = "ta"

    created_at: datetime = Field(default_factory=datetime.utcnow)

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

    # 🔑 Critical for multi-user isolation
    user_id: Optional[int] = Field(
        default=None,
        index=True,
        foreign_key="user.id",
    )

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


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

    created_at: datetime = Field(default_factory=datetime.utcnow)


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
    updated_at: datetime = Field(default_factory=datetime.utcnow)

# --------------------
# Daily Routine (editable)
# --------------------
class DailyRoutine(SQLModel, table=True):
    __tablename__ = "daily_routine"

    id: Optional[int] = Field(default=None, primary_key=True)

    user_id: int = Field(
        index=True,
        foreign_key="user.id",
        unique=True,  # one routine per user
    )

    wake_time: str        # "07:30"
    sleep_time: str       # "23:30"

    work_start: Optional[str] = None  # "09:30"
    work_end: Optional[str] = None    # "18:30"

    daily_habits: Optional[str] = None  # comma-separated for now

    updated_at: datetime = Field(default_factory=datetime.utcnow)

    # --------------------
# User Personality / Character Profile
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
    updated_at: datetime = Field(default_factory=datetime.utcnow)