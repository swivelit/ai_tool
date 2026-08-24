from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

@dataclass(frozen=True)
class IntentDecision:
    intent: str
    route: str
    reason: str
    metadata: dict[str, Any] = field(default_factory=dict)


_WAKE_PREFIXES: tuple[str, ...] = (
    "vanakkam elli",
    "hey elli",
    "hi elli",
    "hello elli",
    "elli",
    "hey swico",
    "hi swico",
    "hello swico",
    "swico",
    "swaiko",
    "vanakkam",
    "வணக்கம் elli",
    "வணக்கம்",
    "hey",
    "hi",
    "hello",
    "can you",
    "could you",
    "please",
)

_WAKE_WORD_PREFIXES = {
    "vanakkam elli",
    "hey elli",
    "hi elli",
    "hello elli",
    "elli",
    "hey swico",
    "hi swico",
    "hello swico",
    "swico",
    "swaiko",
    "vanakkam",
    "வணக்கம் elli",
    "வணக்கம்",
    "hey",
    "hi",
    "hello",
}

_PURE_GREETING_PHRASES = {
    "hi",
    "hello",
    "hey",
    "vanakkam",
    "வணக்கம்",
    "namaste",
    "good morning",
    "good evening",
    "elli",
    "hi elli",
    "hey elli",
    "hello elli",
    "vanakkam elli",
    "வணக்கம் elli",
    "elli hi",
    "elli hello",
    "elli hey",
}

_QUESTION_OR_SUBJECT_RE = re.compile(
    r"(\?|"
    r"\bwhat\b|\bwhy\b|\bhow\b|\btell\s+me\b|\bexplain\b|\babout\b|"
    r"\bdisease\b|\bsymptoms?\b|\btreatments?\b|\bdo\s+you\s+know\b|"
    r"\bcan\s+you\b|\bcould\s+you\b)",
    re.I,
)

_HIGH_CONFIDENCE_CODING_ACTION_RE = re.compile(
    r"\b(?:create|implement|debug|write|generate|provide|build)\b",
    re.IGNORECASE,
)
_TECHNICAL_CODING_MARKER_RE = re.compile(
    r"\b(?:code|coding|python|sql|sqlite|gradio|react(?:\s+native)?|fastapi|"
    r"function|class|api|model|library|database|colab|installation|"
    r"implementation)\b",
    re.IGNORECASE,
)

_URGENT_CHEST_PAIN_RE = re.compile(
    r"\b(?:sudden|severe|crushing|pressure|tightness)?\s*chest\s+pain\b",
    re.IGNORECASE,
)
_URGENT_BREATHING_RE = re.compile(
    r"\b(?:difficulty|trouble|shortness)\s+(?:with\s+)?breath(?:ing)?\b|"
    r"\b(?:cannot|can't|unable\s+to)\s+breathe\b",
    re.IGNORECASE,
)
_URGENT_RADIATION_RE = re.compile(
    r"\b(?:pain\s+)?(?:spreading|radiating|travelling)\s+to\s+(?:the\s+)?"
    r"(?:left\s+)?(?:arm|shoulder|jaw|back)\b",
    re.IGNORECASE,
)

_HARMFUL_CREDENTIAL_ABUSE_RE = re.compile(
    r"\b(?:steal|obtain|capture|harvest|phish(?:ing)?\s+for|take\s+over|"
    r"compromise|break\s+into|gain\s+access\s+to)\b.{0,80}"
    r"\b(?:another\s+person(?:'s)?|someone\s+else(?:'s)?|their|victim(?:'s)?)?\s*"
    r"(?:passwords?|credentials?|login|account|email)\b|"
    r"\b(?:bypass|evade|defeat)\b.{0,50}\b(?:login|authentication|mfa|2fa)\b|"
    r"\b(?:credential\s+phishing|password\s+theft|account\s+takeover)\b",
    re.IGNORECASE | re.DOTALL,
)
_DEFENSIVE_ACCOUNT_SECURITY_RE = re.compile(
    r"\b(?:my|own)\b.{0,35}\b(?:password|credentials?|login|account|email)\b|"
    r"\b(?:reset|recover|secure|protect|harden)\b.{0,50}"
    r"\b(?:password|credentials?|login|authentication|account|email)\b|"
    r"\b(?:compromised|hacked)\b.{0,30}\b(?:my|account|email)\b|"
    r"\b(?:implement|design|explain|learn|audit|test)\b.{0,50}"
    r"\b(?:legitimate\s+)?(?:login|authentication|mfa|2fa|password\s+security)\b",
    re.IGNORECASE | re.DOTALL,
)

_UNCONDITIONAL_SAFETY_RE = re.compile(
    r"\b(?:suicide|self[- ]?harm|kill myself|hurt myself|harm myself|"
    r"overdose|cannot breathe|can't breathe|chest pain)\b",
    re.IGNORECASE,
)
_AMBIGUOUS_CLINICAL_RE = re.compile(
    r"\b(?:emergency|diagnos(?:e|is)|dosage|prescription|bleeding)\b",
    re.IGNORECASE,
)
_HEALTH_DOMAIN_RE = re.compile(
    r"\b(?:symptom|patient|illness|disease|condition|doctor|hospital|medical|"
    r"health|fever|infection|blood|medicine|drug|mg|ml|pain)\b",
    re.IGNORECASE,
)
_TECHNICAL_DOMAIN_RE = re.compile(
    r"\b(?:bug|error|exception|code|application|database|query|server|latency|"
    r"performance|bottleneck|memory leak|stack trace|cpu|index|deployment|log)\b",
    re.IGNORECASE,
)

_INTERROGATIVE_LEAD_RE = re.compile(
    r"^\s*(?:what|why|how|which|who|when|where|is|are|do|does|did|can|"
    r"could|should|would|explain|tell\s+me|describe|compare|define|"
    r"help\s+me\s+understand|difference\s+between)\b",
    re.IGNORECASE,
)
_TOPIC_FRAME_RE = re.compile(
    r"\b(?:best\s+way\s+to|how\s+does\s+\w+(?:\s+\w+){0,5}\s+work|"
    r"what\s+is\s+the\s+difference|examples?\s+of|why\s+do\s+people|"
    r"in\s+general)\b",
    re.IGNORECASE,
)
_ASSISTANT_DIRECTED_RE = re.compile(
    r"\b(?:remind\s+me|remember\s+this|save\s+this|note\s+this|"
    r"add\s+(?:a\s+)?(?:task|to[- ]?do|note|reminder)|"
    r"set\s+(?:a\s+)?(?:reminder|alarm|routine)|"
    r"read\s+aloud\s+(?:this|it|the)|speak\s+(?:this|it)|"
    r"transcribe\s+(?:this|the\s+audio)|open\s+my|show\s+my|find\s+my|"
    r"delete\s+my|update\s+my|change\s+my|my\s+profile|"
    r"my\s+routine|"
    r"what\s+do\s+you\s+know\s+about\s+me|who\s+am\s+i)\b",
    re.IGNORECASE,
)

# A content verb is not enough to invoke a device tool. This shared lookahead
# rejects deliverable-shaped continuations after every tool object.
_CONTENT_DELIVERABLE_NOUN_NEGATIVE_LOOKAHEAD = (
    r"(?!\s+(?:(?:[A-Za-z0-9_-]+\s+){0,2}(?:"
    r"list|outline|template|guide|structure|script|caption|brief|idea|ideas|"
    r"plan|checklist|layout|tracker|convention|prompt|prompts|description|"
    r"wording|strategy|strategies|example|examples)\b))"
)

# This positive signal requires the verb to name a user-owned/stored object.
# In particular, ``create a task list`` remains ordinary content generation,
# while ``create a task`` remains a task command.
_EXPLICIT_TOOL_OBJECT_ACTION_RE = re.compile(
    r"\b(?:set|add|save|create|delete|update|open|show|find|remind|change)\b"
    r"(?:\s+[A-Za-z0-9_-]+){0,2}\s+(?:"
    r"(?:my|our|this|that|these|those)\s+(?:"
    r"(?:[A-Za-z0-9_-]+\s+)?routine|(?:[A-Za-z0-9_-]+\s+)?notes?|"
    r"(?:[A-Za-z0-9_-]+\s+)?reminders?|(?:[A-Za-z0-9_-]+\s+)?alarms?|"
    r"(?:[A-Za-z0-9_-]+\s+)?profiles?|(?:[A-Za-z0-9_-]+\s+)?settings?|"
    r"(?:[A-Za-z0-9_-]+\s+)?tasks?|(?:[A-Za-z0-9_-]+\s+)?todos?|"
    r"(?:[A-Za-z0-9_-]+\s+)?to-dos?|(?:[A-Za-z0-9_-]+\s+)?documents?|"
    r"(?:[A-Za-z0-9_-]+\s+)?files?|(?:[A-Za-z0-9_-]+\s+)?folders?|"
    r"(?:[A-Za-z0-9_-]+\s+)?preferences?|reply\s+language"
    r")\b"
    + _CONTENT_DELIVERABLE_NOUN_NEGATIVE_LOOKAHEAD
    + r"|"
    r"(?:a|an|the)\s+(?:"
    r"(?:[A-Za-z0-9_-]+\s+)?reminder|(?:[A-Za-z0-9_-]+\s+)?alarm|"
    r"(?:[A-Za-z0-9_-]+\s+)?note|(?:[A-Za-z0-9_-]+\s+)?routine|"
    r"(?:[A-Za-z0-9_-]+\s+)?profile|(?:[A-Za-z0-9_-]+\s+)?settings?|"
    r"(?:[A-Za-z0-9_-]+\s+)?tasks?|(?:[A-Za-z0-9_-]+\s+)?todos?|"
    r"(?:[A-Za-z0-9_-]+\s+)?to-dos?|"
    r"(?:microsoft\s+word|word|excel|powerpoint)\s+(?:file|document|sheet)"
    r")\b"
    + _CONTENT_DELIVERABLE_NOUN_NEGATIVE_LOOKAHEAD
    + r"|"
    r"(?:a|an|the)\s+(?:[A-Za-z0-9_-]+\s+)?(?:file|document)\b"
    + _CONTENT_DELIVERABLE_NOUN_NEGATIVE_LOOKAHEAD
    + r"(?!\s+(?:about|regarding|that|which)\b)"
    + r"|"
    r"(?:notes?|reminders?|alarms?|todos?|to-dos?)\b"
    + _CONTENT_DELIVERABLE_NOUN_NEGATIVE_LOOKAHEAD
    + r")",
    re.IGNORECASE,
)

# Existing website clients use a small set of Tamil/Tanglish imperative
# forms. Keep them bounded to stored/tool objects so content imperatives such
# as ``morning routine suggest pannu`` remain general conversation.
_NATIVE_TOOL_OBJECT_ACTION_RE = re.compile(
    r"(?:\b(?:save|add|create|open|show|remind|change)\b|"
    r"(?:ஆக்கி|வை|பண்ணு|பண்ண|pannu|pannunga))"
    r".{0,80}\b(?:pdf|docx?|xlsx?|pptx?|document|file|sheet|notes?|"
    r"task(?!\s+list)|todo|remind(?:er)?|medicine)\b|"
    r"\b(?:pdf|docx?|xlsx?|pptx?|document|file|sheet|notes?|task(?!\s+list)|todo|"
    r"remind(?:er)?|medicine)\b.{0,80}"
    r"(?:ஆக்கி|வை|பண்ணு|பண்ண|pannu|pannunga)",
    re.IGNORECASE,
)
_LEGACY_REMEMBER_ACTION_RE = re.compile(
    r"^\s*remember\s+(?!me\b).{3,}$", re.IGNORECASE
)
_EXPLICIT_SETTINGS_ACTION_RE = re.compile(
    r"\bchange\b.{0,40}\breply\s+language\b", re.IGNORECASE
)
_EXPLICIT_RETRIEVAL_ACTION_RE = re.compile(
    r"\b(?:open|find|show)\s+the\s+(?:business|work|home)\s+"
    r"(?:notes?|files?|documents?)\b", re.IGNORECASE
)
_EXPLICIT_CREATIVE_ACTION_RE = re.compile(
    r"\b(?:create|make|edit|generate|clean\s+up|cleanup)\b\s+"
    r"(?:my|our|this|that|these|those|a|an|the)\s+"
    r"(?:poster|image|photo|video|audio|song|thumbnail|recording)\b"
    + _CONTENT_DELIVERABLE_NOUN_NEGATIVE_LOOKAHEAD,
    re.IGNORECASE,
)
_EXPLICIT_FILE_FORMAT_ACTION_RE = re.compile(
    r"\b(?:create|generate|make|save|open|find|delete)\b"
    r"(?:\s+[A-Za-z0-9_-]+){0,2}\s+(?:a|an|the|my|this|that)\s+"
    r"(?:pdf|docx?|xlsx?|pptx?)\b"
    + _CONTENT_DELIVERABLE_NOUN_NEGATIVE_LOOKAHEAD,
    re.IGNORECASE,
)
_NATIVE_TOOL_LANGUAGE_SIGNAL_RE = re.compile(
    r"[\u0b80-\u0bff]|\b(?:pannu|pannunga)\b", re.IGNORECASE
)
_CONTENT_OBJECT_CONTEXT_RE = re.compile(
    r"\b(?:task|tasks?)\s+(?:prioritisation|prioritization)\b",
    re.IGNORECASE,
)


def is_tool_action_request(text: str) -> bool:
    t = str(text or "").strip()
    if not t:
        return False
    if _ASSISTANT_DIRECTED_RE.search(t):
        return True
    if _INTERROGATIVE_LEAD_RE.search(t):
        return False
    if _TOPIC_FRAME_RE.search(t):
        return False
    if t.rstrip().endswith("?"):
        return False
    if _CONTENT_OBJECT_CONTEXT_RE.search(t):
        return False
    native_tool_action = bool(
        _NATIVE_TOOL_LANGUAGE_SIGNAL_RE.search(t)
        and _NATIVE_TOOL_OBJECT_ACTION_RE.search(t)
    )
    return bool(
        _EXPLICIT_TOOL_OBJECT_ACTION_RE.search(t)
        or native_tool_action
        or _LEGACY_REMEMBER_ACTION_RE.search(t)
        or _EXPLICIT_SETTINGS_ACTION_RE.search(t)
        or _EXPLICIT_RETRIEVAL_ACTION_RE.search(t)
        or _EXPLICIT_FILE_FORMAT_ACTION_RE.search(t)
        or _EXPLICIT_CREATIVE_ACTION_RE.search(t)
    )


_CONVERSATIONAL_LOCAL = {"greeting", "thanks", "capabilities"}
_DEVICE_TOOL_INTENTS = {
    "reminder", "routine", "profile", "settings", "note", "task",
    "document", "file_retrieval", "creative_tool",
}
_GATED_TOOL_INTENTS = _DEVICE_TOOL_INTENTS | {"tts", "stt"}

_PROFESSIONAL_ADVICE_RE = re.compile(
    r"\b(?:should\s+i\s+(?:sue|invest)|"
    r"what\s+should\s+i\s+invest\s+in|"
    r"(?:give|provide)\s+me\s+(?:some\s+)?(?:medical|legal|tax|investment)\s+advice|"
    r"(?<!do\s)i\s+(?:need|want)\s+(?:some\s+)?(?:medical|legal|tax|investment)\s+advice|"
    r"is\s+my\s+case\b|my\s+lawyer\b)\b",
    re.IGNORECASE,
)
_CLINICAL_INFORMATIONAL_RE = re.compile(
    r"\bwhat\s+does\b[^?\n]{0,100}\bdiagnos(?:e|is)\b[^?\n]{0,100}\binvolve\b",
    re.IGNORECASE,
)
_UNSAFE_OR_SENSITIVE_RE = re.compile(
    r"\b(?:suicide|self[- ]?harm|kill myself|hurt myself|harm myself|"
    r"emergency|cannot breathe|can't breathe|chest pain|overdose|bleeding|"
    r"medical advice|diagnos(?:e|is)|prescription|dosage|legal advice|lawsuit|"
    r"tax advice|investment advice|stock tip)\b",
    re.IGNORECASE,
)


def is_harmful_credential_abuse(message: str) -> bool:
    text = str(message or "").strip()
    if not text or _DEFENSIVE_ACCOUNT_SECURITY_RE.search(text):
        return False
    return bool(_HARMFUL_CREDENTIAL_ABUSE_RE.search(text))


def is_urgent_medical_emergency(message: str) -> bool:
    text = str(message or "")
    return bool(
        _URGENT_CHEST_PAIN_RE.search(text)
        and (
            _URGENT_BREATHING_RE.search(text)
            or _URGENT_RADIATION_RE.search(text)
        )
    )


def is_unsafe_or_sensitive(message: str) -> bool:
    text = str(message or "")
    if _UNCONDITIONAL_SAFETY_RE.search(text) or _PROFESSIONAL_ADVICE_RE.search(text):
        return True
    if _CLINICAL_INFORMATIONAL_RE.search(text):
        return False
    return bool(
        _AMBIGUOUS_CLINICAL_RE.search(text)
        and _HEALTH_DOMAIN_RE.search(text)
        and not _TECHNICAL_DOMAIN_RE.search(text)
    )


_CONTEXTUAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "contextual_reference",
        re.compile(
            r"(?:\b(?:explain|rewrite|summarize)\s+(?:that|this|it|the previous answer)\b|"
            r"\btranslate\s+(?:that|it|the previous answer)\b|"
            r"\bwhat about (?:that|this|the (?:first|second|third|last) option)\b|"
            r"\b(?:the )?(?:first|second|third|last) option\b)",
            re.I,
        ),
    ),
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
            r"(?:\bmake\s+(?:it|that|this)\s+(?:shorter|short|concise|brief)\b|\bshort\s+ah\s+sollu(?:nga)?\b|"
            r"\bsummar(?:y|ize)\s+it\b|\bshorten\s+it\b)",
            re.I,
        ),
    ),
)

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("unsafe_or_sensitive", _UNSAFE_OR_SENSITIVE_RE),
    ("file_retrieval", re.compile(r"\b(open|find|show|get|retrieve)\b.*\b(file|files|doc|docs|document|documents|pdf|notes?)\b|\b(?:yesterday|today|nethu|naethu|inniku|business|work|home)\b.*\b(?:open|find|show|notes?|pdf|file)\b|\b(?:நேத்து|நேற்று|இன்று|business|work|home)\b.*\b(?:open|find|show|notes?|pdf|file|காட்டு|திற)\b|(?:file|pdf|notes?)\s+(?:show|open)\s*(?:பண்ணு|pannu)?", re.I)),
    ("creative_tool", re.compile(r"\b(create|make|edit|generate|clean up|cleanup)\b.*\b(poster|image|photo|video|audio|song|voice edit|thumbnail|recording)\b|\b(poster|image|photo|video|audio)\b.*\b(edit|editing|generate|cleanup|clean up)\b", re.I)),
    ("document", re.compile(
        r"\b(?:pdf|docx|xlsx|pptx|csv)\b|"
        r"\b(?:microsoft\s+word|word\s+(?:document|file)|excel(?:\s+sheet)?|"
        r"powerpoint|ppt|spreadsheet|slides?)\b|"
        r"\b(?:document|file)\b.{0,80}\b(?:ஆக்கி|aakki|akki|make|create|generate|save|வை|pannu|பண்ணு)\b|"
        r"\b(?:ஆக்கி|aakki|akki|make|create|generate)\b.{0,80}\b(?:document|file)\b",
        re.I,
    )),
    ("reminder", re.compile(r"\b(remind|reminders?|alarms?|appointments?|calendar)\b|நினைவூட்ட|நினைவு|remind\s*(?:பண்ணு|pannu|panna)|reminder\s*(?:save|வை|pannu)|நாளைக்கு.*remind|(?:tomorrow|naalaikku|nalai|நாளைக்கு|நாளை).*\breminder\b", re.I)),
    ("note", re.compile(r"\b(?:save|remember|add|create|take)\s+(?:this\s+)?notes?\b|\b(?:save|add|put)\s+it\s+to\s+notes?\b|^\s*remember\s+(?!me\b).{3,}|\bnotes?\b.*\b(?:business|work|home)\s+folder\b|\bnotes?\b.*(?:folder\s+ல|folder\s+la|ல\s*வை|save\s*பண்ணு|save\s*pannu)|\b(?:note|notes?)\s+(?:save|வை|pannu|பண்ணு)\b|\bsave this\b|\bremember this\b|குறிப்பு|\b(?:folder|business|work|home)\s+(?:ல|la)\s+(?:வை|save|put)?\b", re.I)),
    ("task", re.compile(r"\b(?:add|create|save|set)\s+(?:a\s+)?(?:tasks?|todos?|to-dos?)\b|\b(?:tasks?|todos?|to-dos?)\b.*\b(?:add|save|வை|pannu|பண்ணு)\b|\b(tasks?|todos?|to-dos?|follow up|follow-up)\b|பணி", re.I)),
    ("routine", re.compile(r"\b(routine|schedule|wake time|sleep time|daily habit|habits|check[- ]?in)\b", re.I)),
    ("profile", re.compile(r"\b(my profile|who am i|my name|about me|my goal|my goals|my personality|what do you know about me)\b", re.I)),
    ("settings", re.compile(
        r"\b(?:settings|reply language|assistant name|change language)\b|"
        r"\b(?:change|set|update|switch|configure|edit|save)\b.{0,50}\bpreferences?\b|"
        r"\bpreferences?\b.{0,50}\b(?:change|update|settings)\b",
        re.I,
    )),
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


def normalize_voice_query_for_intent(message: str) -> dict[str, Any]:
    original = str(message or "").strip()
    cleaned = original
    stripped_prefixes: list[str] = []
    stripped_wake_word = False

    while cleaned:
        match = _match_leading_prefix(cleaned)
        if not match:
            break
        prefix, end = match
        stripped_prefixes.append(prefix)
        stripped_wake_word = stripped_wake_word or prefix.lower() in _WAKE_WORD_PREFIXES
        cleaned = cleaned[end:].strip()
        cleaned = re.sub(r"^[\s,.:;!?،।\-–—]+", "", cleaned).strip()

    return {
        "original": original,
        "normalized": cleaned,
        "stripped_wake_word": stripped_wake_word,
        "stripped_prefix": ", ".join(stripped_prefixes) if stripped_prefixes else "",
    }


def is_pure_greeting(message: str) -> bool:
    original = str(message or "").strip()
    if not original:
        return False
    if _QUESTION_OR_SUBJECT_RE.search(original):
        return False

    compact = _compact_phrase(original)
    if compact in _PURE_GREETING_PHRASES:
        return True

    normalized = normalize_voice_query_for_intent(original)
    remainder = _compact_phrase(str(normalized.get("normalized") or ""))
    if normalized.get("stripped_wake_word") and not remainder:
        return True
    if normalized.get("stripped_wake_word") and remainder in _PURE_GREETING_PHRASES:
        return True
    return False


def looks_like_question_after_greeting(message: str) -> bool:
    normalized = normalize_voice_query_for_intent(message)
    text = str(normalized.get("normalized") or "").strip()
    if not text:
        return False
    if is_pure_greeting(message):
        return False
    return bool(_QUESTION_OR_SUBJECT_RE.search(text) or len(_compact_phrase(text).split()) > 2)


def classify_intent(message: str) -> IntentDecision:
    return classify_intent_with_metadata(message)


def classify_intent_with_metadata(message: str) -> IntentDecision:
    ...


def classify_intent_with_metadata(message: str) -> IntentDecision:
    normalization = normalize_voice_query_for_intent(message)
    original = str(normalization["original"])
    normalized = str(normalization["normalized"])
    intent_before = _classify_intent_text(original, prefix_greeting=True)
    classify_text = normalized or original
    intent_after = _classify_intent_text(classify_text, original_message=original, prefix_greeting=False)
    metadata = {
        **normalization,
        **intent_after.metadata,
        "intent_before_cleanup": intent_before.intent,
        "intent_after_cleanup": intent_after.intent,
    }
    return IntentDecision(
        intent=intent_after.intent,
        route=intent_after.route,
        reason=intent_after.reason,
        metadata=metadata,
    )


def _classify_intent_text(
    message: str,
    *,
    original_message: str | None = None,
    prefix_greeting: bool = False,
) -> IntentDecision:
    text = str(message or "").strip()
    source_text = str(original_message or text).strip()
    contextual = classify_contextual_followup(text)
    if contextual is not None:
        return contextual
    if is_urgent_medical_emergency(text):
        return IntentDecision(
            intent="urgent_medical_emergency",
            route="safety",
            reason="clear_emergency_symptoms",
        )
    if is_harmful_credential_abuse(text):
        return IntentDecision(
            intent="harmful_credential_abuse",
            route="safety",
            reason="credential_abuse_safety_path",
        )
    if (
        _HIGH_CONFIDENCE_CODING_ACTION_RE.search(text)
        and _TECHNICAL_CODING_MARKER_RE.search(text)
    ):
        return IntentDecision(
            intent="coding",
            route="coding",
            reason="coding_build_request",
        )
    for intent, pattern in _PATTERNS:
        if pattern.search(text):
            if intent == "unsafe_or_sensitive" and not is_unsafe_or_sensitive(text):
                continue
            if intent == "greeting":
                if not prefix_greeting and not is_pure_greeting(original_message or text):
                    continue
            if intent in _CONVERSATIONAL_LOCAL:
                return IntentDecision(intent=intent, route="backend_tool", reason=f"{intent}_tool_intent")
            if intent in _GATED_TOOL_INTENTS:
                if is_tool_action_request(source_text):
                    route = "backend_tool" if intent in _DEVICE_TOOL_INTENTS else intent
                    return IntentDecision(intent=intent, route=route, reason=f"{intent}_tool_intent")
                return IntentDecision(
                    intent="general",
                    route="general",
                    reason=f"{intent}_topic_question_not_tool_action",
                    metadata={"tool_intent_candidate": intent},
                )
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
        if intent != "contextual_reference" and _has_explicit_subject(text):
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


def _match_leading_prefix(text: str) -> tuple[str, int] | None:
    value = str(text or "").lstrip()
    for prefix in sorted(_WAKE_PREFIXES, key=len, reverse=True):
        pattern = re.compile(rf"^{re.escape(prefix)}(?=$|[\s,.:;!?،।\-–—])", re.I)
        match = pattern.search(value)
        if match:
            return prefix, match.end()
    return None


def _compact_phrase(value: str) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^\w\s\u0b80-\u0bff]+", " ", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()
