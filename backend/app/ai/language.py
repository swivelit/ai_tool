from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


INDIC_REPLY_LANGUAGE_ALIASES = {"ta", "tamil", "mixed", "tanglish"}

_SCRIPT_RANGES: tuple[tuple[str, str, str], ...] = (
    ("ta", "\u0b80", "\u0bff"),
    ("hi", "\u0900", "\u097f"),
    ("te", "\u0c00", "\u0c7f"),
    ("ml", "\u0d00", "\u0d7f"),
    ("kn", "\u0c80", "\u0cff"),
    ("bn", "\u0980", "\u09ff"),
    ("mr", "\u0900", "\u097f"),
    ("gu", "\u0a80", "\u0aff"),
    ("pa", "\u0a00", "\u0a7f"),
    ("or", "\u0b00", "\u0b7f"),
)

_ROMANIZED_INDIC_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "ta",
        re.compile(
            r"\b("
            r"tamil|tanglish|vanakkam|nandri|enna|eppadi|sapadu|saapadu|"
            r"sollu|sollunga|pannu|pannunga|venum|irukku|illa|seri|romba|"
            r"naan|unga|ungal|namma|thambi|akka|anna|theni|kovai|madurai"
            r")\b",
            re.IGNORECASE,
        ),
    ),
    (
        "hi",
        re.compile(
            r"\b("
            r"hindi|hinglish|namaste|kaise|kya|kyun|nahi|nahin|haan|hai|"
            r"mujhe|aap|tum|kal|aaj|batao|samjhao|karna|karo|chahiye"
            r")\b",
            re.IGNORECASE,
        ),
    ),
    (
        "indic",
        re.compile(
            r"\b("
            r"telugu|malayalam|kannada|bengali|marathi|gujarati|punjabi|"
            r"odia|transliterate|transliteration|bharat|desi"
            r")\b",
            re.IGNORECASE,
        ),
    ),
)


@dataclass(frozen=True)
class LanguageDecision:
    language: str
    is_indic: bool
    code_mixed: bool
    prefer_provider: str
    reason: str


def _normalized_reply_language(reply_language: Optional[str]) -> str:
    return str(reply_language or "").strip().lower()


def _script_language(message: str) -> Optional[str]:
    for char in str(message or ""):
        for language, start, end in _SCRIPT_RANGES:
            if start <= char <= end:
                return language
    return None


def _romanized_language(message: str) -> Optional[str]:
    text = str(message or "")
    for language, pattern in _ROMANIZED_INDIC_PATTERNS:
        if pattern.search(text):
            return language
    return None


def detect_language(message: str, reply_language: Optional[str] = None) -> LanguageDecision:
    reply = _normalized_reply_language(reply_language)
    if reply in INDIC_REPLY_LANGUAGE_ALIASES:
        language = "ta" if reply != "mixed" else "mixed"
        return LanguageDecision(
            language=language,
            is_indic=True,
            code_mixed=reply in {"mixed", "tanglish"},
            prefer_provider="sarvam",
            reason="reply_language_prefers_indic",
        )

    script_language = _script_language(message)
    if script_language:
        return LanguageDecision(
            language=script_language,
            is_indic=True,
            code_mixed=False,
            prefer_provider="sarvam",
            reason="indic_unicode_script",
        )

    romanized_language = _romanized_language(message)
    if romanized_language:
        return LanguageDecision(
            language=romanized_language,
            is_indic=True,
            code_mixed=True,
            prefer_provider="sarvam",
            reason="romanized_or_code_mixed_indic",
        )

    return LanguageDecision(
        language="en",
        is_indic=False,
        code_mixed=False,
        prefer_provider="openai",
        reason="default_english",
    )


def should_prefer_sarvam(message: str, reply_language: Optional[str] = None) -> bool:
    return detect_language(message, reply_language).prefer_provider == "sarvam"
