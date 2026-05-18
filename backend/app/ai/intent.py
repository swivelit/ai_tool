from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class IntentDecision:
    intent: str
    route: str
    reason: str


_CONTEXTUAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "contextual_translate",
        re.compile(r"(?:\btamil\s+la\s+sollu(?:nga)?\b|தமிழில்\s+சொல்ல)", re.I),
    ),
    (
        "contextual_explain",
        re.compile(
            r"(?:\btamil\s+la\b|\bin\s+tamil\b|\bsimple\s+ah\b|\bmake\s+it\s+simple\b|"
            r"\bexplain\s+in\s+tamil\b|தமிழில்|சிம்பிளா|விளக்க)",
            re.I,
        ),
    ),
    (
        "contextual_rewrite",
        re.compile(
            r"(?:\bmake\s+it\s+(?:shorter|short|concise|brief)\b|\bshort\s+ah\s+sollu(?:nga)?\b|"
            r"\bsummar(?:y|ize)\s+it\b|\bshorten\s+it\b)",
            re.I,
        ),
    ),
)

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("unsafe_or_sensitive", re.compile(r"\b(suicide|self[- ]?harm|kill myself|hurt myself|harm myself|emergency|cannot breathe|can't breathe|chest pain|overdose|bleeding|medical advice|diagnos(?:e|is)|prescription|dosage|legal advice|lawsuit|tax advice|investment advice|stock tip)\b", re.I)),
    ("file_retrieval", re.compile(r"\b(open|find|show|get|retrieve)\b.*\b(file|files|doc|docs|document|documents|pdf|notes?)\b|\b(?:நேத்து|நேற்று|yesterday|business|work|home)\b.*\b(?:open|find|show|notes?)\b", re.I)),
    ("creative_tool", re.compile(r"\b(create|make|edit|generate|clean up|cleanup)\b.*\b(poster|image|photo|video|audio|song|voice edit|thumbnail|recording)\b|\b(poster|image|photo|video|audio)\b.*\b(edit|editing|generate|cleanup|clean up)\b", re.I)),
    ("document", re.compile(r"\b(pdf|docx|word document|xlsx|excel|pptx|ppt|powerpoint|csv)\b|(?:pdf|docx|xlsx|pptx)\s*(?:ஆக்கி|akki|aakki)|\b(?:document|file)\b.*\b(?:save|create|generate)\b", re.I)),
    ("reminder", re.compile(r"\b(remind|reminder|alarm|appointment|calendar)\b|நினைவூட்ட|நினைவு|remind\s*பண்ணு|reminder\s*save|நாளைக்கு.*remind", re.I)),
    ("note", re.compile(r"\b(?:save|remember|add|create|take)\s+(?:this\s+)?notes?\b|\b(?:save|remember)\s+(?!me\b).{3,}\b|\bnotes?\b.*\b(?:business|work|home)\s+folder\b|\bnotes?\b.*(?:folder\s+ல|ல\s*வை)|\bsave this\b|\bremember this\b|குறிப்பு|\b(?:folder|business|work|home)\s+ல\s+வை\b", re.I)),
    ("task", re.compile(r"\b(?:add|create|save|set)\s+(?:a\s+)?(?:task|todo|to-do)\b|\b(task|todo|to-do|follow up|follow-up)\b|பணி", re.I)),
    ("routine", re.compile(r"\b(routine|schedule|wake time|sleep time|daily habit|habits|check[- ]?in)\b", re.I)),
    ("profile", re.compile(r"\b(my profile|who am i|my name|about me|my goal|my goals|my personality|what do you know about me)\b", re.I)),
    ("settings", re.compile(r"\b(settings|preference|preferences|reply language|assistant name|change language)\b", re.I)),
    ("coding", re.compile(r"\b(code|coding|debug|bug|stack trace|typescript|python|react native|fastapi|sql|api implementation|function implementation|class implementation|refactor)\b", re.I)),
    ("complex_reasoning", re.compile(r"\b(architecture|design a|multi[- ]?step|trade[- ]?off|deep analysis|reason through|system design|migration plan|debug this architecture)\b", re.I)),
    ("translation", re.compile(r"\b(translate|translation|transliterate|transliteration|convert (?:to|into)|in tamil|tamil la|hindi me|hinglish|tanglish)\b", re.I)),
    ("tts", re.compile(r"\b(text[- ]?to[- ]?speech|tts|speak this|read aloud|voice output)\b", re.I)),
    ("stt", re.compile(r"\b(speech[- ]?to[- ]?text|stt|transcribe|transcription|voice upload)\b", re.I)),
    ("weather", re.compile(r"\b(weather|forecast|rain|temperature|humidity)\b", re.I)),
    ("live_data", re.compile(r"\b(latest news|breaking news|live score|sports score|ipl score|stock price|crypto price|gold rate|exchange rate|election result|election results|current (?:stock|crypto|gold|exchange|weather)|(?:stock|crypto) price|score today|latest .*score|latest .*news)\b", re.I)),
    ("thanks", re.compile(r"^\s*(thanks|thank you|nandri|நன்றி)\b", re.I)),
    ("capabilities", re.compile(r"\b(what can you do|what do you do|help me with|your capabilities|app capabilities)\b|நீ என்ன செய்ய", re.I)),
    ("greeting", re.compile(r"^\s*(hi|hello|hey|vanakkam|வணக்கம்|namaste|good morning|good evening)\b", re.I)),
)


def classify_intent(message: str) -> IntentDecision:
    text = str(message or "").strip()
    contextual = classify_contextual_followup(text)
    if contextual is not None:
        return contextual
    for intent, pattern in _PATTERNS:
        if pattern.search(text):
            if intent in {"reminder", "routine", "profile", "settings", "note", "task", "document", "file_retrieval", "creative_tool", "greeting", "thanks", "capabilities"}:
                return IntentDecision(intent=intent, route="backend_tool", reason=f"{intent}_tool_intent")
            if intent in {"weather", "live_data"}:
                return IntentDecision(intent=intent, route="blocked_live_data", reason="live_data_requires_configured_provider")
            if intent == "unsafe_or_sensitive":
                return IntentDecision(intent=intent, route="safety", reason="high_risk_safety_path")
            return IntentDecision(intent=intent, route=intent, reason=f"{intent}_keyword")
    return IntentDecision(intent="general", route="general", reason="default_general")


def classify_contextual_followup(message: str) -> IntentDecision | None:
    text = str(message or "").strip()
    if not text:
        return None
    for intent, pattern in _CONTEXTUAL_PATTERNS:
        if not pattern.search(text):
            continue
        if _has_explicit_subject(text):
            continue
        return IntentDecision(intent=intent, route=intent, reason=f"{intent}_needs_recent_context")
    return None


def _has_explicit_subject(text: str) -> bool:
    probe = str(text or "").lower()
    removals = (
        r"\btamil\s+la\b",
        r"\bin\s+tamil\b",
        r"\bexplain\s+in\s+tamil\b",
        r"\bexplain\b",
        r"\btranslate\b",
        r"\btranslation\b",
        r"\bmake\b",
        r"\bit\b",
        r"\bthis\b",
        r"\bthat\b",
        r"\bsimple\b",
        r"\bah\b",
        r"\bshort(?:er)?\b",
        r"\bconcise\b",
        r"\bbrief\b",
        r"\bsollu(?:nga)?\b",
        r"\bpannu(?:nga)?\b",
        r"\bplease\b",
        r"தமிழில்",
        r"சொல்லுங்கள்",
        r"சொல்லு",
        r"இதை",
        r"சிம்பிளா",
        r"விளக்க",
        r"வேண்டும்",
    )
    for pattern in removals:
        probe = re.sub(pattern, " ", probe, flags=re.I)
    probe = re.sub(r"[^\w\u0b80-\u0bff]+", " ", probe, flags=re.I)
    words = [word for word in probe.split() if word not in {"la", "ah", "nga"}]
    return len(" ".join(words).strip()) >= 4
