"""
orchestrator_task.py — v3 (Production Grade)

The "Traffic Cop" of the Assistant. 
Analyzes user intent and routes to specialized agents (Greeting, Tool, or General).

Synced with Team Leader's Architecture:
- Keywords derived from 'local_rag_service.py' (DEFAULT_FAST_RAG_ROWS)
- Classification labels match 'stage_english_remodel.py'
- Urgency mapping aligns low/medium/high with TL's numerical priorities (50/90/100)
"""

from __future__ import annotations

import json
import re
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# Constants (Mapped to TL's stage_english & local_rag labels)
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

# ── Keywords (Synced with local_rag_service.py) ─────────────────────────────

_GREETING_KWS: set = {"hi", "hey", "hello", "vanakkam", "வணக்கம்", "ஹாய்", "hai", "ello", "helo", "vanakam"}
_GREETING_STARTS: Tuple[str, ...] = ("good morning", "good evening", "good afternoon", "good night")

_SMALLTALK_KWS: set = {
    "how are you", "how r u", "epdi iruka", "எப்படி இருக்கீங்க", 
    "thanks", "thank you", "nandri", "நன்றி", "thx", "ok", "cool",
}

_PROFILE_KWS: set = {"name", "place", "location", "who am i", "where do i live"}

_ASSISTANT_KWS: set = {"who are you", "help", "what can you do", "assistant name"}

_EMERGENCY_KWS: Tuple[str, ...] = (
    "help me", "danger", "accident", "ambulance", "sos", "emergency", "உதவி", "ஆபத்து"
)

_WEATHER_KWS: Tuple[str, ...] = ("weather", "rain", "forecast", "வெயில்", "மழை", "வானிலை")

_CALENDAR_KWS: Tuple[str, ...] = ("schedule", "reminder", "todo", "appointment", "நினைவூட்டல்", "பணி")

# ─────────────────────────────────────────────────────────────────────────────
# Core Logic
# ─────────────────────────────────────────────────────────────────────────────

def _normalize(text: str) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^\w\s\u0B80-\u0BFF]", " ", text) # Tamil-aware
    return re.sub(r"\s+", " ", text).strip()

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
        "confidence": float(round(confidence, 4)),
        "matched_keyword": matched_keyword,
        "clarification_question": clarification_question,
        "fast_path": fast_path
    }

def _rule_classify(message: str) -> Optional[Dict[str, Any]]:
    """Layer 1: Offline Keyword Search (Synchronized with TL's Fast RAG rules)"""
    norm = _normalize(message)
    if not norm:
        return _make_result(intent="AMBIGUOUS", next_action="Clarification Agent", clarification_question="Pardon? Your message seems empty.")

    # 1. EMERGENCY (Signaling high priority)
    for kw in _EMERGENCY_KWS:
        if kw in norm:
            return _make_result(intent="EMERGENCY", next_action="Emergency Agent", priority="high", matched_keyword=kw)

    # 2. GREETINGS (Mapping to TL's Priority 100)
    if norm in _GREETING_KWS or any(norm.startswith(s) for s in _GREETING_STARTS):
        return _make_result(intent="GREETING", next_action="Greeting Agent", priority="low", matched_keyword=norm)

    # 3. SMALLTALK / THANKS (Mapping to TL's Priority 92-95)
    if any(kw in norm for kw in _SMALLTALK_KWS):
        return _make_result(intent="SMALLTALK", next_action="Greeting Agent", priority="low")

    # 4. PROFILE / ASSISTANT INFO (Mapping to TL's Priority 90-96)
    if any(kw in norm for kw in _PROFILE_KWS):
        return _make_result(intent="PROFILE", next_action="Greeting Agent", priority="low")
    if any(kw in norm for kw in _ASSISTANT_KWS):
        return _make_result(intent="IDENTITY", next_action="Greeting Agent", priority="low")

    # 5. TOOLS (Weather, Calendar)
    if any(kw in norm for kw in _WEATHER_KWS):
        return _make_result(intent="TOOL", next_action="Tool Agent", tool="weather", priority="medium")
    if any(kw in norm for kw in _CALENDAR_KWS):
        return _make_result(intent="TOOL", next_action="Tool Agent", tool="calendar", priority="medium")

    return None

def _call_llm(client: Any, message: str) -> Dict[str, Any]:
    """Layer 2: Online Semantic Router — Only for complex sentences"""
    try:
        prompt = """You are an AI Orchestrator. Classify the input.
Intents: GREETING, SMALLTALK, PROFILE, IDENTITY, TOOL, EMERGENCY, AMBIGUOUS, GENERAL.
Return JSON ONLY: {"intent": "...", "priority": "low|medium|high", "tool": "weather|calendar|web_search|none", "clarification_question": null}"""
        
        response = client.responses.create(
            model="gpt-4o-mini",
            input=[{"role": "system", "content": [{"type": "input_text", "text": prompt}]},
                   {"role": "user", "content": [{"type": "input_text", "text": message}]}],
            temperature=0.0,
            text={"format": {"type": "json_object"}},
        )
        
        # Helper to extract text from response
        raw_text_parts: List[str] = []
        output_text = getattr(response, "output_text", None)
        if output_text: 
            raw_text_parts.append(str(output_text).strip())
        else:
            for item in getattr(response, "output", None) or []:
                for part in getattr(item, "content", None) or []:
                    text_val = getattr(part, "text", None)
                    if text_val: 
                        raw_text_parts.append(str(text_val))
        
        raw_text = "".join(raw_text_parts).strip()
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
