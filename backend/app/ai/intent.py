from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class IntentDecision:
    intent: str
    route: str
    reason: str


_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("unsafe_or_sensitive", re.compile(r"\b(suicide|self[- ]?harm|kill myself|hurt myself|emergency|cannot breathe|can't breathe|chest pain|overdose|bleeding|medical advice|diagnos(?:e|is)|prescription|dosage|legal advice|lawsuit|tax advice|investment advice|stock tip)\b", re.I)),
    ("reminder", re.compile(r"\b(remind|reminder|alarm|todo|to-do|task|appointment|calendar)\b", re.I)),
    ("routine", re.compile(r"\b(routine|schedule|wake time|sleep time|daily habit|habits|check[- ]?in)\b", re.I)),
    ("profile", re.compile(r"\b(my profile|who am i|my name|about me|my goal|my goals|my personality|what do you know about me)\b", re.I)),
    ("settings", re.compile(r"\b(settings|preference|preferences|reply language|assistant name|change language)\b", re.I)),
    ("coding", re.compile(r"\b(code|coding|debug|bug|stack trace|typescript|python|react native|fastapi|sql|api|function|class|refactor|compiler)\b", re.I)),
    ("complex_reasoning", re.compile(r"\b(architecture|design a|multi[- ]?step|trade[- ]?off|deep analysis|reason through|system design|migration plan|debug this architecture)\b", re.I)),
    ("translation", re.compile(r"\b(translate|translation|transliterate|transliteration|convert (?:to|into)|in tamil|tamil la|hindi me|hinglish|tanglish)\b", re.I)),
    ("tts", re.compile(r"\b(text[- ]?to[- ]?speech|tts|speak this|read aloud|voice output)\b", re.I)),
    ("stt", re.compile(r"\b(speech[- ]?to[- ]?text|stt|transcribe|transcription|voice upload)\b", re.I)),
    ("weather", re.compile(r"\b(weather|forecast|rain|temperature|humidity)\b", re.I)),
    ("live_data", re.compile(r"\b(latest|current|live|breaking|today|now|news|score|scores|stock|price|sports score|ipl score|election result|exchange rate|gold rate)\b", re.I)),
    ("greeting", re.compile(r"^\s*(hi|hello|hey|vanakkam|namaste|good morning|good evening)\b", re.I)),
)


def classify_intent(message: str) -> IntentDecision:
    text = str(message or "").strip()
    for intent, pattern in _PATTERNS:
        if pattern.search(text):
            if intent in {"reminder", "routine", "profile", "settings"}:
                return IntentDecision(intent=intent, route="backend_tool", reason=f"{intent}_tool_intent")
            if intent in {"weather", "live_data"}:
                return IntentDecision(intent=intent, route="blocked_live_data", reason="live_data_requires_configured_provider")
            if intent == "unsafe_or_sensitive":
                return IntentDecision(intent=intent, route="safety", reason="high_risk_safety_path")
            return IntentDecision(intent=intent, route=intent, reason=f"{intent}_keyword")
    return IntentDecision(intent="general", route="general", reason="default_general")
