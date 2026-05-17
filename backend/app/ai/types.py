from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional


@dataclass(frozen=True)
class AIRequest:
    user_id: Optional[int]
    message: str
    reply_language: Optional[str]
    channel: Literal["text", "voice", "tool", "background"]
    request_id: Optional[str]
    metadata: dict


@dataclass(frozen=True)
class AIRoute:
    provider: Literal["cache", "backend_tool", "sarvam", "openai", "blocked"]
    model: Optional[str]
    route: str
    reason: str
    language: str
    intent: str
    max_output_tokens: int
    needs_voice_output: bool = False
    model_candidates: list[str] = field(default_factory=list)
    provider_endpoint_candidates: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class AIProviderResponse:
    text: str
    provider: str
    model: Optional[str]
    route: str
    reason: str
    language: str
    intent: str
    input_tokens: int = 0
    output_tokens: int = 0
    audio_seconds: float = 0
    characters: int = 0
    estimated_cost_amount: float = 0
    estimated_cost_currency: str = ""
    raw: dict = field(default_factory=dict)
