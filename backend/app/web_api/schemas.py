from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


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

