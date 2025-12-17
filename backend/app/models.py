from typing import Optional
from datetime import datetime
from sqlmodel import SQLModel, Field


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    place: Optional[str] = None
    timezone: Optional[str] = "Asia/Kolkata"
    assistant_name: str = "Ellie"
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Questionnaire(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True, foreign_key="user.id")
    payload_json: str  # store questionnaire answers as JSON string
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Item(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    intent: str
    category: str
    raw_text: str
    transcript: Optional[str] = None
    datetime_str: Optional[str] = None
    title: Optional[str] = None
    details: Optional[str] = None
    source: str = "text"
    user_id: Optional[int] = Field(default=None, index=True, foreign_key="user.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Conversation(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, index=True, foreign_key="user.id")
    channel: str  # "text" | "voice" | "search" | "system"
    user_input: str
    transcript: Optional[str] = None
    llm_output_json: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class QACache(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: Optional[int] = Field(default=None, index=True, foreign_key="user.id")
    question: str
    answer: str
    hits: int = 1
    updated_at: datetime = Field(default_factory=datetime.utcnow)