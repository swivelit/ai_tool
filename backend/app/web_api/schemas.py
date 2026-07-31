from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    model_config = ConfigDict(extra="forbid")

    request_id: UUID
    message: str = Field(default="", max_length=64_000)
    thread_id: UUID | None = None
    reply_language: str | None = Field(default=None, max_length=16)
    input_mode: Literal["text", "voice", "dictation", "realtime_voice"] = "text"
    voice_turn_id: UUID | None = None
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=5)
    repository_id: UUID | None = None
    continue_message_id: UUID | None = None
    edit_message_id: UUID | None = None
    regenerate_message_id: UUID | None = None

    @model_validator(mode="after")
    def exclusive_mutation(self):
        mutations = (
            self.continue_message_id,
            self.edit_message_id,
            self.regenerate_message_id,
        )
        if sum(value is not None for value in mutations) > 1:
            raise ValueError(
                "continue_message_id, edit_message_id, and "
                "regenerate_message_id cannot be combined"
            )
        return self

    @field_validator("message")
    @classmethod
    def clean_message(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def require_message_or_attachment(self):
        if not self.message and not self.attachment_ids and not self.repository_id:
            raise ValueError(
                "message, attachment, or repository context is required"
            )
        if len(set(self.attachment_ids)) != len(self.attachment_ids):
            raise ValueError("attachment_ids must be unique")
        if self.input_mode in {"voice", "dictation", "realtime_voice"} and self.voice_turn_id is None:
            raise ValueError("voice_turn_id is required for voice input")
        if self.input_mode == "text" and self.voice_turn_id is not None:
            raise ValueError("voice_turn_id is only valid for voice input")
        return self


class VirtualTextUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    upload_id: UUID
    text: str = Field(min_length=1, max_length=64_000)
    operation: Literal["summarize", "analyze", "ask_questions", "rewrite", "translate"] = "analyze"

    @field_validator("text")
    @classmethod
    def valid_unicode(cls, value: str) -> str:
        try:
            value.encode("utf-8", errors="strict")
        except UnicodeError as exc:
            raise ValueError("text contains invalid Unicode") from exc
        if not value.strip():
            raise ValueError("text cannot be blank")
        return value


class WebTTSRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: UUID
    message_id: str = Field(min_length=1, max_length=64)
    voice_turn_id: UUID


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


class AssistantSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tier: Literal["lite", "standard", "pro"]


class MemorySettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


class MessageFeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rating: Literal["up", "down"]


ResponseProvenance = Literal[
    "memory",
    "document",
    "cached_answer",
    "semantic_cache",
    "backend_tool",
    "web_search",
]


class AssistantMessageSchema(BaseModel):
    """Shared assistant response extension used by list and SSE payloads."""

    provenance: list[ResponseProvenance] = Field(default_factory=list)
