from __future__ import annotations

from dataclasses import dataclass
import re
import unicodedata
from typing import Literal

from ..ai.intent import classify_contextual_followup


SameThreadContextMode = Literal["off", "explicit_only", "adaptive", "always_last"]


@dataclass(frozen=True)
class SameThreadContinuityDecision:
    """Sanitized, provider-free decision about bounded same-chat history."""

    mode: SameThreadContextMode
    use_context: bool
    reason: str
    confidence: float
    preferred_turn_count: int


_VALID_MODES: frozenset[str] = frozenset(
    {"off", "explicit_only", "adaptive", "always_last"}
)

_RESET_RE = re.compile(
    r"(?:^|[.!?;:]\s*)(?:"
    r"new\s+topic|unrelated\s+(?:question|topic)|separate\s+question|"
    r"different\s+question|changing\s+the\s+subject|ignore\s+the\s+previous\s+answer|"
    r"start\s+over|forget\s+the\s+above|moving\s+on|"
    r"வேறு\s+கேள்வி|புதிய\s+(?:topic|தலைப்பு)|vera\s+question|unrelated\s+ah"
    r")(?=$|[\s:,.!?;\-–—])",
    re.IGNORECASE,
)

_REFERENCE_RE = re.compile(
    r"(?:"
    r"\b(?:it|its|itself|this|that|these|those|they|them|their|above|previous|"
    r"earlier|same|former|latter|he|she|him|her)\b|"
    r"\b(?:first|second|third|last)\s+one\b|"
    r"\b(?:that|this)\s+(?:section|approach|code|plan|roadmap)\b|"
    r"\bthose\s+steps\b|"
    r"இதை|அதை|இதுக்கு|அதுக்கு|அடுத்தது\s+என்ன|இதை\s+எப்படி|"
    r"\b(?:idha|adha|idhuku|adhuku|adutha\s+step|next\s+enna|example\s+kudu|"
    r"konjam\s+explain\s+pannu)\b"
    r")",
    re.IGNORECASE,
)

_ELLIPTICAL_RE = re.compile(
    r"^(?:please\s+)?(?:"
    r"why|how|what\s+next|then\s+what|continue|go\s+on|more|explain\s+more|"
    r"(?:can\s+you\s+)?give\s+me\s+an?\s+example|show\s+(?:me\s+)?the\s+code|"
    r"how\s+(?:do|would|should|can)\s+(?:i|we|you)\s+(?:implement|test|use|apply)(?:\s+it)?|"
    r"what\s+(?:are|would\s+be)\s+the\s+(?:advantages|disadvantages|benefits|drawbacks)|"
    r"what\s+about\s+[^?!.]{1,80}|compare\s+the\s+(?:two|three|options|approaches)|"
    r"expand\s+(?:that|this|the)?\s*(?:section|part|point)?|"
    r"(?:start|begin)\s+with\s+(?:phase|step)\s*\d+|show\s+(?:phase|step)\s*\d+|"
    r"can\s+you\s+(?:simplify|make)\s+(?:it|this|that)(?:\s+practical)?|"
    r"can\s+you\s+make\s+it\s+practical|"
    r"what\s+should\s+i\s+learn\s+next|"
    r"அடுத்தது\s+என்ன|இதுக்கு\s+example\s+கொடு|"
    r"idha\s+eppadi\s+implement\s+panradhu|adutha\s+step\s+enna"
    r")[\s?.!]*$",
    re.IGNORECASE,
)

_MULTI_TURN_RE = re.compile(
    r"\b(?:compare|first|second|third|former|latter|phase\s*\d+|step\s*\d+|"
    r"continue|go\s+on|previous\s+(?:answer|turns?))\b",
    re.IGNORECASE,
)

_BOUNDED_INCOMPLETE_RE = re.compile(
    r"^(?:now\s+)?(?:show|start|begin)\s+(?:phase|step)\s*\d+\.?$|"
    r"^(?:continue|go\s+on|then\s+what|what\s+next)\s*[?.!]*$",
    re.IGNORECASE,
)

_PERSON_REFERENCE_RE = re.compile(r"\b(?:he|she|him|her)\b", re.IGNORECASE)

_REFERENCE_TERMS = frozenset({
    "above", "earlier", "former", "it", "its", "itself", "same", "that",
    "these", "they", "them", "their", "those", "this", "previous",
    "more", "simply", "short", "shorter", "brief", "section", "fix",
    "advantages", "அடுத்தது", "இதுக்கு", "அதை", "இதை",
})

_STANDALONE_RE = re.compile(
    r"^(?:(?:can|could|would)\s+you\s+)?(?:what\s+is|who\s+is|define|explain|"
    r"tell\s+me\s+about)\s+(.+?)[?.!]*$",
    re.IGNORECASE,
)

_HOW_STANDALONE_RE = re.compile(
    r"^how\s+(?:do|would|should|can)\s+(?:i|we|you)\s+(.+?)[?.!]*$",
    re.IGNORECASE,
)

_IMPLEMENTATION_FOLLOWUP_RE = re.compile(
    r"^how\s+(?:do|would|should|can)\s+(?:i|we|you)\s+"
    r"(?:add|configure|deploy|implement|integrate|test|use|apply)\b",
    re.IGNORECASE,
)

_STOP_WORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
        "could", "did", "do", "does", "for", "from", "give", "had", "has", "have",
        "how", "i", "in", "is", "me", "more", "my", "of", "on", "or", "please",
        "should", "show", "tell", "than", "the", "then", "to", "was", "were", "what",
        "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
        "explain", "define", "implement", "implementation", "test", "testing", "use", "using",
        "add", "make", "learn", "next", "example", "advantages", "disadvantages", "part",
        "section", "phase", "step", "one", "two", "three", "இது", "ஒரு", "என்ன", "எப்படி",
        "கொடு", "சொல்லு", "pannu", "panradhu", "enna", "eppadi", "kudu", "konjam",
    }
)

_LEXICAL_OVERLAP_STOP_WORDS = frozenset(
    {"likely", "most", "first", "change", "best", "next", "issue", "problem"}
)

_GENERIC_SUBJECT_TERMS = frozenset({
    "approach", "best", "change", "failure", "first", "fix", "issue",
    "likely", "mode", "most", "next", "option", "problem", "solution",
    "step", "system", "thing", "way",
})

_UNBOUND_SUBJECT_RE = re.compile(
    r"\b(?:the\s+)?(?:most\s+likely|best|first|next)\s+"
    r"(?:failure\s+mode|approach|change|step|option|solution|fix|action|way)\b|"
    r"\bwhat(?:'s|\s+is)\s+(?:the\s+)?best\s+approach\b|"
    r"\bwhat\s+should\s+(?:i|we|you)\s+(?:change|do|fix|try)\s+"
    r"(?:first|next)\b",
    re.IGNORECASE,
)

_NAMED_IMPLEMENTATION_SUBJECT_RE = re.compile(
    r"\b[A-Z][A-Za-z0-9.+#-]{2,}\b|"
    r"\b[A-Za-z0-9_-]+\.(?:py|js|jsx|ts|tsx|java|go|rs|sql|json|ya?ml)\b|"
    r"(?:^|\s)(?:/[A-Za-z0-9_.-]+)+",
)


def normalize_same_thread_context_mode(value: str | None) -> SameThreadContextMode:
    normalized = str(value or "explicit_only").strip().lower()
    return normalized if normalized in _VALID_MODES else "explicit_only"  # type: ignore[return-value]


def decide_same_thread_continuity(
    message: str,
    recent_turns: list[dict[str, str]],
    *,
    mode: str,
) -> SameThreadContinuityDecision:
    """Choose same-thread continuity without a model, embedding, or network call."""

    selected_mode = normalize_same_thread_context_mode(mode)
    text = re.sub(r"\s+", " ", str(message or "")).strip()
    if selected_mode == "off":
        return _decision(selected_mode, False, "mode_off", 1.0, 0)
    if not recent_turns:
        return _decision(selected_mode, False, "no_complete_history", 1.0, 0)
    if not text:
        return _decision(selected_mode, False, "empty_message", 1.0, 0)
    if _RESET_RE.search(text):
        return _decision(selected_mode, False, "explicit_topic_reset", 0.99, 0)
    if selected_mode == "always_last":
        return _decision(selected_mode, True, "always_last", 0.98, 1)

    current_terms = _meaningful_tokens(text)
    # A subject supplied by the current message always wins. This check must
    # precede contextual intent and pronoun matching: phrases such as
    # "Explain this Python code" and "the first option in argparse" contain
    # reference words, but do not need the previous turn to identify their
    # subject.
    if _has_clear_standalone_subject(text, current_terms):
        return _decision(selected_mode, False, "clear_standalone_subject", 0.92, 0)

    explicit = classify_contextual_followup(text)
    if explicit is not None:
        return _decision(
            selected_mode, True, "explicit_followup", 0.99, _preferred_count(text)
        )
    if selected_mode == "explicit_only":
        return _decision(selected_mode, False, "explicit_followup_not_detected", 0.9, 0)

    if _REFERENCE_RE.search(text):
        if _PERSON_REFERENCE_RE.search(text) and not _has_person_antecedent(recent_turns):
            return _decision(selected_mode, False, "unresolved_person_reference", 0.88, 0)
        return _decision(
            selected_mode, True, "referential_language", 0.96, _preferred_count(text)
        )
    if _ELLIPTICAL_RE.match(text):
        return _decision(
            selected_mode, True, "elliptical_followup", 0.93, _preferred_count(text)
        )

    history_terms: set[str] = set()
    for turn in recent_turns[-2:]:
        history_terms.update(_meaningful_tokens(turn.get("user") or ""))
        history_terms.update(_meaningful_tokens(turn.get("assistant") or ""))
    overlap = (
        current_terms - _LEXICAL_OVERLAP_STOP_WORDS
    ) & (
        history_terms - _LEXICAL_OVERLAP_STOP_WORDS
    )
    if overlap:
        return _decision(
            selected_mode, True, "lexical_topic_overlap", _overlap_confidence(overlap),
            _preferred_count(text),
        )

    if _IMPLEMENTATION_FOLLOWUP_RE.match(text) and len(current_terms) <= 2:
        return _decision(
            selected_mode, True, "missing_application_subject", 0.74, 1
        )

    if _BOUNDED_INCOMPLETE_RE.match(text) or (
        _UNBOUND_SUBJECT_RE.search(text)
        and not (current_terms - _GENERIC_SUBJECT_TERMS - _REFERENCE_TERMS)
    ):
        return _decision(
            selected_mode, True, "bounded_incomplete_followup", 0.82,
            _preferred_count(text),
        )
    return _decision(selected_mode, False, "self_contained_no_overlap", 0.78, 0)


def _decision(
    mode: SameThreadContextMode,
    use_context: bool,
    reason: str,
    confidence: float,
    preferred_turn_count: int,
) -> SameThreadContinuityDecision:
    return SameThreadContinuityDecision(
        mode=mode,
        use_context=use_context,
        reason=reason,
        confidence=max(0.0, min(1.0, confidence)),
        preferred_turn_count=max(0, min(2, preferred_turn_count if use_context else 0)),
    )


def _preferred_count(text: str) -> int:
    return 2 if _MULTI_TURN_RE.search(text) else 1


def _meaningful_tokens(text: str) -> set[str]:
    terms: set[str] = set()
    for raw in _unicode_tokens(text):
        token = unicodedata.normalize("NFKC", raw).casefold().strip("._-/:{}")
        if not token or token in _STOP_WORDS or len(token) <= 1:
            continue
        terms.add(token)
    return terms


def _overlap_confidence(overlap: set[str]) -> float:
    return min(0.95, 0.78 + (0.05 * min(3, len(overlap))))


def _has_clear_standalone_subject(text: str, terms: set[str]) -> bool:
    concrete_terms = terms - _GENERIC_SUBJECT_TERMS - _REFERENCE_TERMS
    if _UNBOUND_SUBJECT_RE.search(text) and not concrete_terms:
        return False
    match = _STANDALONE_RE.match(text)
    if match and (
        _meaningful_tokens(match.group(1)) - _GENERIC_SUBJECT_TERMS - _REFERENCE_TERMS
    ):
        return True
    how_match = _HOW_STANDALONE_RE.match(text)
    if how_match and _IMPLEMENTATION_FOLLOWUP_RE.match(text):
        return bool(_NAMED_IMPLEMENTATION_SUBJECT_RE.search(how_match.group(1)))
    if how_match and len(
        _meaningful_tokens(how_match.group(1)) - _GENERIC_SUBJECT_TERMS - _REFERENCE_TERMS
    ) >= 2:
        return True
    # Short noun-phrase questions and entity switches can be complete current
    # requests even without "what is" or "who is".
    if (
        len(concrete_terms) >= 2
        and re.search(r"\b(?:of|in|for)\s+[A-Z][\w-]+", text)
    ):
        return True
    if (
        re.search(r"\b(?:code|function|script|program|class)\b", text, re.I)
        and concrete_terms
    ):
        return True
    if (
        re.search(r"[\u0b80-\u0bff]", text)
        and re.search(r"(?:என்ன|யார்|எப்படி)\s*[?!.]*$", text)
        and concrete_terms
    ):
        return True
    # Longer questions/statements with several concrete terms are sufficiently
    # specified to stand alone even when they do not use a canned opening.
    return bool(
        len(_unicode_tokens(text)) >= 10
        and len(terms) >= 4
        and concrete_terms
    )


def _has_person_antecedent(recent_turns: list[dict[str, str]]) -> bool:
    """Require a bounded, person-shaped antecedent for he/she references."""
    text = " ".join(
        str(turn.get(key) or "")
        for turn in recent_turns[-2:]
        for key in ("user", "assistant")
    )
    if re.search(
        r"\b(?:person|man|woman|president|prime minister|chief minister|"
        r"governor|researcher|author|developer|teacher|he|she)\b",
        text,
        re.IGNORECASE,
    ):
        return True
    # Preserve ordinary named-person follow-ups without maintaining a name
    # database. Two adjacent capitalized words are a conservative antecedent.
    return bool(re.search(r"\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b", text))


def _unicode_tokens(text: str) -> list[str]:
    """Tokenize Unicode letters/marks/numbers while retaining code connectors."""
    value = unicodedata.normalize("NFKC", str(text or ""))
    tokens: list[str] = []
    current: list[str] = []
    connectors = frozenset("_./:-{}")

    def flush() -> None:
        if current:
            token = "".join(current).strip("._-/:{}")
            if token:
                tokens.append(token)
            current.clear()

    for index, character in enumerate(value):
        category = unicodedata.category(character)
        if category[0] in {"L", "M", "N"} or character == "_":
            current.append(character)
            continue
        next_character = value[index + 1] if index + 1 < len(value) else ""
        next_category = unicodedata.category(next_character) if next_character else ""
        if (
            character in connectors
            and (current or character == "/")
            and (next_category[:1] in {"L", "M", "N"} or next_character in {"_", "{"})
        ):
            current.append(character)
            continue
        flush()
    flush()
    return tokens
