from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ThreadCreate(BaseModel):
    title: str = Field(default="New chat", max_length=120)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        return " ".join(value.split()).strip() or "New chat"


class ThreadPatch(BaseModel):
    title: str | None = Field(default=None, max_length=120)
    archived: bool | None = None

    @field_validator("title")
    @classmethod
    def clean_optional_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split()).strip()
        if not cleaned:
            raise ValueError("title cannot be empty")
        return cleaned


class WebChatRequest(BaseModel):
    request_id: UUID
    message: str = Field(min_length=1, max_length=16_000)
    thread_id: UUID | None = None
    reply_language: str | None = Field(default=None, max_length=16)

    @field_validator("message")
    @classmethod
    def clean_message(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("message cannot be empty")
        return cleaned


class ProfilePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=80)
    place: str | None = Field(default=None, max_length=120)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    assistant_name: str | None = Field(default=None, min_length=1, max_length=40)
    reply_language: str | None = Field(default=None, min_length=2, max_length=2)

    @field_validator("name", "assistant_name", mode="before")
    @classmethod
    def required_text(cls, value):
        if value is None:
            return value
        cleaned = " ".join(str(value).split())
        if not cleaned:
            raise ValueError("This field cannot be empty.")
        return cleaned

    @field_validator("place", mode="before")
    @classmethod
    def optional_text(cls, value):
        if value is None:
            return None
        cleaned = " ".join(str(value).split())
        return cleaned or None

    @field_validator("timezone", mode="before")
    @classmethod
    def clean_timezone(cls, value):
        return str(value).strip() if value is not None else value

    @field_validator("reply_language", mode="before")
    @classmethod
    def supported_language(cls, value):
        if value is None:
            return value
        cleaned = str(value).strip().lower()
        if cleaned not in {"en", "ta"}:
            raise ValueError("Reply language must be English or Tamil.")
        return cleaned


class UsagePreferencesPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    period: Literal["monthly"] | None = None
    hard_limit_micros: int | None = None
    hard_limit_estimated_tokens: int | None = None
    warning_threshold_percent: int | None = Field(default=None, ge=1, le=100)
    notify_at_threshold: bool | None = None

    @field_validator("hard_limit_micros", mode="before")
    @classmethod
    def integer_micros_only(cls, value):
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("Hard limit must be an integer micro-INR amount.")
        if value <= 0:
            raise ValueError("Hard limit must be positive or null.")
        return value

    @field_validator("hard_limit_estimated_tokens", mode="before")
    @classmethod
    def integer_tokens_only(cls, value):
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError("Estimated token limit must be a positive integer or null.")
        return value
