from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=24_000)


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: list[Message] = Field(min_length=1, max_length=24)
    max_output_tokens: int = Field(default=512, ge=1, le=512)

    @field_validator("messages")
    @classmethod
    def bounded_messages(cls, value: list[Message]) -> list[Message]:
        if sum(len(item.content) for item in value) > 24_000:
            raise ValueError("messages exceed the request limit")
        return value


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    texts: list[str] = Field(min_length=1, max_length=16)
    modes: list[Literal["query", "passage"]] = Field(min_length=1, max_length=16)

    @field_validator("texts")
    @classmethod
    def bounded_texts(cls, value: list[str]) -> list[str]:
        if any(not item.strip() or len(item) > 12_000 for item in value):
            raise ValueError("embedding text is empty or too large")
        return value

    @field_validator("modes")
    @classmethod
    def modes_match(cls, value: list[str], info):
        texts = info.data.get("texts")
        if texts is not None and len(value) != len(texts):
            raise ValueError("modes must match texts")
        return value
