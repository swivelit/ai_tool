from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ToolCapability:
    name: str
    kind: str
    provider_env: str
    configured: bool
    provider: Optional[str] = None


_TOOL_ENV_BY_KIND = {
    "image": "IMAGE_TOOL_PROVIDER",
    "poster": "IMAGE_TOOL_PROVIDER",
    "video": "VIDEO_TOOL_PROVIDER",
    "audio": "AUDIO_TOOL_PROVIDER",
}


def get_tool_capability(kind: str) -> ToolCapability:
    normalized = str(kind or "").strip().lower() or "unknown"
    provider_env = _TOOL_ENV_BY_KIND.get(normalized, f"{normalized.upper()}_TOOL_PROVIDER")
    provider = os.getenv(provider_env, "").strip()
    api_key = os.getenv(f"{provider.upper()}_API_KEY", "").strip() if provider else ""
    return ToolCapability(
        name=normalized,
        kind=normalized,
        provider_env=provider_env,
        configured=bool(provider and api_key),
        provider=provider or None,
    )
