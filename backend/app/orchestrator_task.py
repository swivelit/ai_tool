"""
orchestrator_task.py — v3.1 (Emergency Enhanced)

The "Traffic Cop" of the Assistant. 
Analyzes user intent and routes to specialized agents (Greeting, Tool, or General).

Updated: Added Medical Emergency detection for dog bites, broken bones, and bleeding.
"""

from __future__ import annotations

import json
import re
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

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

# ── Keywords ────────────────────────────────────────────────────────────────

_GREETING_KWS: set = {"hi", "hey", "hello", "vanakkam", "வணக்கம்", "ஹாய்", "hai", "ello", "helo", "vanakam"}
_GREETING_STARTS: Tuple[str, ...] = ("good morning", "good evening", "good afternoon", "good night")

_SMALLTALK_KWS: set = {
    "how are you", "how r u", "epdi iruka", "எப்படி இருக்கீங்க", 
    "thanks", "thank you", "nandri", "நன்றி", "thx", "ok", "cool",
}

_PROFILE_KWS: set = {"name", "place", "location", "who am i", "where do i live"}

_ASSISTANT_KWS: set = {"who are you", "help", "what can you do", "assistant name"}

_EMERGENCY_KWS: Tuple[str, ...] = (
    "help me", "danger", "accident", "ambulance", "sos", "emergency", "உதவி", "ஆபத்து",
    "bite", "bit", "broken", "bleeding", "snake", "dog", "கடி", "உடை", "காயம்", "இரத்தம்"
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
    for kw in _EMERGENCY_KWS:
        if kw in norm:
            return _make_result(intent="EMERGENCY", next_action="Emergency Agent", priority="high", matched_keyword=kw)

    # 2. GREETINGS
    if norm in _GREETING_KWS or any(norm.startswith(s) for s in _GREETING_STARTS):
        return _make_result(intent="GREETING", next_action="Greeting Agent", priority="low", matched_keyword=norm)

    # 3. SMALLTALK / THANKS
    if any(kw in norm for kw in _SMALLTALK_KWS):
        return _make_result(intent="SMALLTALK", next_action="Greeting Agent", priority="low")

    # 4. PROFILE / ASSISTANT INFO
    if any(kw in norm for kw in _PROFILE_KWS):
        return _make_result(intent="PROFILE", next_action="Greeting Agent", priority="low")
    if any(kw in norm for kw in _ASSISTANT_KWS):
        return _make_result(intent="IDENTITY", next_action="Greeting Agent", priority="low")

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
- If the query is about medical emergency, dog bites, broken bones, bleeding, or accidents, use EMERGENCY.
- If the query is ambiguous or a fragment, use AMBIGUOUS and generate a specific clarifying question.
- If it requires external data (weather, calendar, web search), use TOOL.
Return JSON ONLY: {"intent": "...", "priority": "low|medium|high", "tool": "weather|calendar|web_search|none", "clarification_question": "optional text"}"""
        
        response = client.chat.completions.create(
            model="gpt-4o-mini",
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

if __name__ == "__main__":
    # Test stub
    class MockClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    class Choice:
                        class Message:
                            content = '{"intent": "TOOL", "priority": "medium", "tool": "web_search"}'
                        message = Message()
                    class Resp:
                        choices = [Choice()]
                    return Resp()
    
    print(run_orchestrator(MockClient(), "What is the capital of France?"))
