from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .types import AIProviderResponse


@dataclass(frozen=True)
class AgentIntentResult:
    intent: str
    category: str
    language: str
    confidence: float
    reason: str
    requires_provider: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentPlan:
    action: str
    intent: str
    route: str
    category: str
    language: str
    confidence: float
    reason: str
    provider_allowed: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentRuntimeResult:
    response: Optional[AIProviderResponse]
    plan: AgentPlan
    run_id: Optional[int]
