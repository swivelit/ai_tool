"""
orchestrator_task.py — v3.1 (Emergency Enhanced)

The "Traffic Cop" of the Assistant. 
Analyzes user intent and routes to specialized agents (Greeting, Tool, or General).

Updated: Added precise Medical Emergency detection for bites, severe injury, bleeding, breathing trouble, and self-harm.
"""

from __future__ import annotations

import json
import re
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

from .openai_model_router import OpenAIModelRouter

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

VALID_INTENTS = {
    "GREETING",      # Matches label: "greeting"
    "SMALLTALK",     # Matches label: "smalltalk"
    "PROFILE",       # Matches label: "profile"
    "IDENTITY",      # Matches label: "assistant_identity"
    "TOOL",          # Matches route: "weather", "calendar", "web_search"
    "EMERGENCY",     # For urgent signaling
    "AMBIGUOUS",     # Fragment detection
    "GENERAL",       # Fallback to pipeline
}

VALID_NEXT_ACTIONS = {
    "Greeting Agent", "Clarification Agent", "Tool Agent",
    "General Agent", "Emergency Agent",
}

VALID_TOOLS = {"weather", "web_search", "calendar", "none"}
VALID_PRIORITIES = {"low", "medium", "high"}

# ── Keywords / Patterns ─────────────────────────────────────────────────────

_GREETING_KWS: set = {"hi", "hey", "hello", "vanakkam", "வணக்கம்", "ஹாய்", "hai", "ello", "helo", "vanakam"}
_GREETING_STARTS: Tuple[str, ...] = ("good morning", "good evening", "good afternoon", "good night")

_SMALLTALK_KWS: set = {
    "how are you", "how r u", "epdi iruka", "எப்படி இருக்கீங்க", 
    "thanks", "thank you", "nandri", "நன்றி", "thx", "ok", "cool",
}
_SMALLTALK_PATTERNS: Tuple[Tuple[str, re.Pattern[str]], ...] = tuple(
    (
        keyword,
        re.compile(
            rf"(?<![a-z0-9_\u0B80-\u0BFF]){re.escape(keyword)}(?![a-z0-9_\u0B80-\u0BFF])"
        ),
    )
    for keyword in sorted(_SMALLTALK_KWS, key=len, reverse=True)
)

_PROFILE_PHRASES: Tuple[str, ...] = (
    "my name",
    "my place",
    "my location",
    "who am i",
    "where do i live",
    "what is my name",
    "what is my location",
)

_ASSISTANT_EXACT_PHRASES: set = {"help"}
_ASSISTANT_PHRASES: Tuple[str, ...] = ("who are you", "what can you do", "assistant name")


def _compile_phrase_patterns(phrases: Tuple[str, ...]) -> Tuple[Tuple[str, re.Pattern[str]], ...]:
    boundary = r"[a-z0-9_\u0B80-\u0BFF]"
    return tuple(
        (
            phrase,
            re.compile(rf"(?<!{boundary}){re.escape(phrase)}(?!{boundary})"),
        )
        for phrase in sorted(set(phrases), key=len, reverse=True)
    )


_PROFILE_PATTERNS = _compile_phrase_patterns(_PROFILE_PHRASES)
_ASSISTANT_PATTERNS = _compile_phrase_patterns(_ASSISTANT_PHRASES)

_EMERGENCY_PATTERNS: Tuple[Tuple[str, re.Pattern[str]], ...] = (
    (
        "dog bite",
        re.compile(
            r"\b(?:"
            r"dog\s+bites?|"
            r"dog\s+bit\s+(?:me|my|us|someone|child|kid|friend|him|her|them)|"
            r"bit(?:ten)?\s+by\s+(?:a\s+)?dog"
            r")\b"
        ),
    ),
    (
        "snake bite",
        re.compile(
            r"\b(?:"
            r"snake\s+bites?|"
            r"snake\s+bit\s+(?:me|my|us|someone|child|kid|friend|him|her|them)|"
            r"bit(?:ten)?\s+by\s+(?:a\s+)?snake"
            r")\b"
        ),
    ),
    (
        "severe bleeding",
        re.compile(
            r"\b(?:"
            r"i\s+(?:am|m)\s+bleeding|"
            r"(?:heavy|severe|bad|badly|heavy|heavily|uncontrolled|uncontrollable)\s+bleeding|"
            r"bleeding\s+(?:badly|heavily|a\s+lot|too\s+much|won\s+t\s+stop|does\s+not\s+stop)|"
            r"blood\s+(?:won\s+t|will\s+not|does\s+not|doesn\s+t)\s+stop|"
            r"losing\s+(?:a\s+lot\s+of\s+)?blood"
            r")\b"
        ),
    ),
    (
        "chest pain or breathing trouble",
        re.compile(
            r"\b(?:"
            r"chest\s+pain|heart\s+attack|"
            r"(?:cannot|cant|can\s+t)\s+breathe|"
            r"not\s+breathing|difficulty\s+breathing|trouble\s+breathing|"
            r"shortness\s+of\s+breath|choking"
            r")\b"
        ),
    ),
    (
        "accident",
        re.compile(
            r"\b(?:"
            r"accident|emergency|ambulance|sos|"
            r"car\s+crash|bike\s+crash|road\s+crash|road\s+accident|"
            r"hit\s+by\s+(?:a\s+)?(?:car|bus|truck|bike|motorcycle)"
            r")\b"
        ),
    ),
    (
        "broken bone",
        re.compile(
            r"\b(?:"
            r"broken\s+(?:bone|leg|arm|wrist|ankle|hand|finger|toe|rib|neck|back)|"
            r"fractured\s+(?:bone|leg|arm|wrist|ankle|hand|finger|toe|rib|neck|back)"
            r")\b"
        ),
    ),
    (
        "self harm",
        re.compile(
            r"\b(?:"
            r"suicidal|suicide|self\s+harm|"
            r"(?:want\s+to\s+|going\s+to\s+|might\s+|will\s+)?(?:harm|hurt|kill)\s+myself|"
            r"end\s+my\s+life|take\s+my\s+life|want\s+to\s+die|"
            r"cut\s+myself|overdose(?:d)?"
            r")\b"
        ),
    ),
    (
        "urgent tamil safety",
        re.compile(
            r"(?:"
            r"ஆபத்து|அவசர|ஆம்புலன்ஸ்|"
            r"நாய்\s+கடி|நாய்\s+கடித்த|பாம்பு\s+கடி|பாம்பு\s+கடித்த|"
            r"மார்பு\s+வலி|மூச்சு\s+விட\s+முடியவில்லை|"
            r"இரத்தம்\s+வருகிறது|தற்கொலை"
            r")"
        ),
    ),
)

_WEATHER_KWS: Tuple[str, ...] = ("weather", "rain", "forecast", "வெயில்", "மழை", "வானிலை")

_CALENDAR_KWS: Tuple[str, ...] = ("schedule", "reminder", "todo", "appointment", "நினைவூட்டல்", "பணி")

# ─────────────────────────────────────────────────────────────────────────────
# Core Logic
# ─────────────────────────────────────────────────────────────────────────────

def _normalize(text: str) -> str:
    if not text: return ""
    text = text.strip().lower()
    text = re.sub(r"[^\w\s\u0B80-\u0BFF]", " ", text) # Tamil-aware
    return re.sub(r"\s+", " ", text).strip()

def _match_emergency(norm: str) -> str:
    for label, pattern in _EMERGENCY_PATTERNS:
        if pattern.search(norm):
            return label
    return ""

def _match_smalltalk(norm: str) -> str:
    for label, pattern in _SMALLTALK_PATTERNS:
        if pattern.search(norm):
            return label
    return ""

def _match_phrase(norm: str, patterns: Tuple[Tuple[str, re.Pattern[str]], ...]) -> str:
    for label, pattern in patterns:
        if pattern.search(norm):
            return label
    return ""

def _match_assistant(norm: str) -> str:
    if norm in _ASSISTANT_EXACT_PHRASES:
        return norm
    return _match_phrase(norm, _ASSISTANT_PATTERNS)

def _make_result(
    *,
    intent: str,
    next_action: str,
    tool: str = "none",
    priority: str = "low",
    confidence: float = 1.0,
    matched_keyword: str = "",
    clarification_question: Optional[str] = None,
    fast_path: bool = True
) -> Dict[str, Any]:
    return {
        "intent": intent,
        "next_action": next_action,
        "tool": tool,
        "priority": priority,
        "confidence": round(float(confidence), 4),
        "matched_keyword": matched_keyword,
        "clarification_question": clarification_question,
        "fast_path": fast_path
    }

def _rule_classify(message: str) -> Optional[Dict[str, Any]]:
    """Layer 1: Offline Keyword Search"""
    norm = _normalize(message)
    if not norm:
        return _make_result(
            intent="AMBIGUOUS", 
            next_action="Clarification Agent", 
            clarification_question="Pardon? Your message seems empty. How can I help you today?",
            fast_path=True
        )

    # 1. EMERGENCY (Signaling high priority)
    emergency_match = _match_emergency(norm)
    if emergency_match:
        return _make_result(
            intent="EMERGENCY",
            next_action="Emergency Agent",
            priority="high",
            matched_keyword=emergency_match,
        )

    # 2. GREETINGS
    if norm in _GREETING_KWS or any(norm.startswith(s) for s in _GREETING_STARTS):
        return _make_result(intent="GREETING", next_action="Greeting Agent", priority="low", matched_keyword=norm)

    # 3. SMALLTALK / THANKS
    smalltalk_match = _match_smalltalk(norm)
    if smalltalk_match:
        return _make_result(
            intent="SMALLTALK",
            next_action="Greeting Agent",
            priority="low",
            matched_keyword=smalltalk_match,
        )

    # 4. PROFILE / ASSISTANT INFO
    profile_match = _match_phrase(norm, _PROFILE_PATTERNS)
    if profile_match:
        return _make_result(
            intent="PROFILE",
            next_action="Greeting Agent",
            priority="low",
            matched_keyword=profile_match,
        )
    assistant_match = _match_assistant(norm)
    if assistant_match:
        return _make_result(
            intent="IDENTITY",
            next_action="Greeting Agent",
            priority="low",
            matched_keyword=assistant_match,
        )

    # 5. TOOLS
    if any(kw in norm for kw in _WEATHER_KWS):
        return _make_result(intent="TOOL", next_action="Tool Agent", tool="weather", priority="medium")
    if any(kw in norm for kw in _CALENDAR_KWS):
        return _make_result(intent="TOOL", next_action="Tool Agent", tool="calendar", priority="medium")

    return None

def _call_llm(client: Any, message: str) -> Dict[str, Any]:
    """Layer 2: Online Semantic Router"""
    try:
        prompt = """You are an AI Orchestrator. Analyzes the intent and decides what to do next.
Intents: GREETING, SMALLTALK, PROFILE, IDENTITY, TOOL, EMERGENCY, AMBIGUOUS, GENERAL.
- If it's a simple greeting, use GREETING.
- Use EMERGENCY only for current urgent safety needs: dog/snake bite, severe bleeding, chest pain, breathing trouble, accidents, broken bones, suicidal intent, or self-harm. Do not classify harmless mentions like dog stories, snake games, broken code, or computing bits as EMERGENCY.
- If the query is ambiguous or a fragment, use AMBIGUOUS and generate a specific clarifying question.
- If it requires external data (weather, calendar, web search), use TOOL.
Return JSON ONLY: {"intent": "...", "priority": "low|medium|high", "tool": "weather|calendar|web_search|none", "clarification_question": "optional text"}"""
        
        selection = OpenAIModelRouter().select_model("routing", message)
        response = client.chat.completions.create(
            model=selection.model,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": message}
            ],
            temperature=0.0,
            response_format={"type": "json_object"},
        )
        
        raw_text = response.choices[0].message.content
        parsed = json.loads(raw_text)
        intent = parsed.get("intent", "GENERAL").upper()
        
        # Decide next action based on LLM Intent
        action = "General Agent"
        if intent == "EMERGENCY": action = "Emergency Agent"
        elif intent == "AMBIGUOUS": action = "Clarification Agent"
        elif intent == "TOOL": action = "Tool Agent"
        elif intent in {"GREETING", "SMALLTALK", "PROFILE", "IDENTITY"}: action = "Greeting Agent"

        return _make_result(
            intent=intent,
            next_action=action,
            tool=parsed.get("tool", "none"),
            priority=parsed.get("priority", "low"),
            clarification_question=parsed.get("clarification_question"),
            fast_path=False
        )
    except Exception:
        return _make_result(intent="GENERAL", next_action="General Agent", priority="low", fast_path=False)

def run_orchestrator(client: Any, message: str) -> Dict[str, Any]:
    """Public router Entry Point"""
    # 🏃 Fast Rules (Offline check)
    result = _rule_classify(message)
    if result: return result

    # 🧠 Semantic AI (Online check)
    return _call_llm(client, message)
