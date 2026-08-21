"""Pure realtime Voice protocol, endpointing, and safety helpers.

This module deliberately contains no audio, transcript, credential, or database
logging.  Keeping the timing and mapping rules pure makes them deterministic to
test without connecting to Sarvam or another live service.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from enum import Enum


class VoiceState(str, Enum):
    CONNECTING = "connecting"
    LISTENING = "listening"
    ENDPOINT_PENDING = "endpoint_pending"
    THINKING = "thinking"
    SPEAKING = "speaking"
    INTERRUPTED = "interrupted"
    CLOSING = "closing"
    ERROR = "error"
    CLOSED = "closed"


VOICE_CLOSE_CODES = {
    "voice_protocol_mismatch": 4400,
    "voice_session_expired": 4401,
    "voice_origin_rejected": 4403,
    "voice_session_active": 4409,
    "voice_rate_limit": 4429,
    "insufficient_chat_credit": 4450,
    "insufficient_voice_credit": 4451,
    "sarvam_authentication_failed": 4460,
    "sarvam_quota_exhausted": 4461,
    "sarvam_temporarily_unavailable": 4462,
    "sarvam_protocol_error": 4463,
    "voice_idle_timeout": 4470,
    "voice_maximum_duration": 4471,
    "voice_network_interrupted": 4472,
    "voice_internal_failure": 4500,
}

SAFE_CLOSE_REASONS = {
    code: name for name, code in VOICE_CLOSE_CODES.items()
}


@dataclass(frozen=True)
class VoiceEndpointConfig:
    adaptive_enabled: bool = True
    end_silence_ms: int = 900
    unfinished_grace_ms: int = 650
    max_endpoint_wait_ms: int = 1800
    min_speech_ms: int = 250
    max_utterance_ms: int = 30_000
    barge_in_min_ms: int = 180
    preroll_ms: int = 320

    @classmethod
    def from_env(cls) -> "VoiceEndpointConfig":
        return cls(
            adaptive_enabled=_enabled("WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED", True),
            end_silence_ms=_positive_int("WEB_REALTIME_VOICE_END_SILENCE_MS", 900),
            unfinished_grace_ms=_positive_int("WEB_REALTIME_VOICE_UNFINISHED_GRACE_MS", 650),
            max_endpoint_wait_ms=_positive_int("WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS", 1800),
            min_speech_ms=_positive_int("WEB_REALTIME_VOICE_MIN_SPEECH_MS", 250),
            max_utterance_ms=_positive_int("WEB_REALTIME_VOICE_MAX_UTTERANCE_MS", 30_000),
            barge_in_min_ms=_positive_int("WEB_REALTIME_VOICE_BARGE_IN_MIN_MS", 180),
            preroll_ms=_positive_int("WEB_REALTIME_VOICE_PREROLL_MS", 320),
        )


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(str(os.getenv(name, str(default))).strip())
    except ValueError:
        return default
    return value if value > 0 else default


def _enabled(name: str, default: bool) -> bool:
    value = str(os.getenv(name, "true" if default else "false")).strip().lower()
    if value in {"1", "true", "yes", "y", "on"}:
        return True
    if value in {"0", "false", "no", "n", "off"}:
        return False
    return default


_EN_CONTINUATIONS = re.compile(
    r"(?:\b(?:and|but|because|so|if|when|while|although|though|that|which|who|"
    r"to|for|with|from|like|then|also|actually|basically|well|um|uh)\s*|[,;:\-–—])$",
    re.IGNORECASE,
)
_TA_CONTINUATIONS = re.compile(
    r"(?:\b(?:மற்றும்|ஆனால்|ஏனெனில்|அதனால்|என்றால்|பிறகு|மேலும்|அதாவது|"
    r"என்று|என|போல|உம்|ம்)\s*|[,;:\-–—])$"
)
_TERMINAL = re.compile(r"[.!?।…]\s*$")


def transcript_appears_unfinished(transcript: str, language: str) -> bool:
    """Bounded text heuristic only; this does not infer emotion or prosody."""
    cleaned = " ".join(str(transcript or "").split()).strip()
    if not cleaned or _TERMINAL.search(cleaned):
        return False
    if str(language).lower().startswith("ta") or str(language).lower() == "tanglish":
        return bool(_TA_CONTINUATIONS.search(cleaned))
    if str(language).lower().startswith("en"):
        return bool(_EN_CONTINUATIONS.search(cleaned))
    # For languages without a maintained continuation lexicon, rely on the
    # provider's final state, VAD, punctuation/stability, and the bounded
    # endpoint timer.  Applying English conjunctions to another script can
    # keep a completed utterance open indefinitely.
    return False


def endpoint_delay_ms(transcript: str, language: str, config: VoiceEndpointConfig) -> int:
    delay = config.end_silence_ms
    if transcript_appears_unfinished(transcript, language):
        delay += config.unfinished_grace_ms
    return min(delay, config.max_endpoint_wait_ms)


def join_final_segments(segments: list[str]) -> str:
    return " ".join(" ".join(value.split()).strip() for value in segments if value.strip()).strip()


def safe_provider_category(close_code: int | None, reason: str = "") -> str:
    """Map provider closure to a stable category without retaining raw reason."""
    lowered = str(reason or "").lower()
    if close_code in {4001, 4003, 4401, 4403} or any(
        marker in lowered for marker in ("auth", "api key", "unauthor", "forbidden")
    ):
        return "authentication"
    if close_code in {4008, 4029, 429, 4429} or any(
        marker in lowered for marker in ("quota", "rate limit", "too many")
    ):
        return "quota"
    if close_code in {1002, 1003, 1007, 1008} or "protocol" in lowered:
        return "protocol"
    if close_code in {1001, 1006, 1011, 1012, 1013} or close_code is None:
        return "temporary"
    return "unknown"


def provider_error_code(category: str) -> str:
    return {
        "authentication": "sarvam_authentication_failed",
        "quota": "sarvam_quota_exhausted",
        "protocol": "sarvam_protocol_error",
        "temporary": "sarvam_temporarily_unavailable",
    }.get(category, "sarvam_temporarily_unavailable")
