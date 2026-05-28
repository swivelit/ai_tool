from __future__ import annotations

import os
import re
from typing import Any

from .types import AIRequest, AIRoute


APP_CONTEXT_PROMPT = (
    "The user is building J AI, an AI mobile app. Tailor coding, product, and "
    "architecture answers to this app: a React Native/Expo mobile frontend talks "
    "to a FastAPI backend-first AI control plane. The backend owns auth, budget, "
    "safety, cache, memory/RAG, usage and cost logging, and provider routing. "
    "Sarvam is used for Indic, Tanglish, Tamil, STT, TTS, and translation. "
    "OpenAI uses a cheap model ladder for English, general QA, and reasoning. "
    "Local model runtime is optional fallback/development only. Avoid generic "
    "GraphQL or microservice boilerplate unless the user asks for it."
)

UNCLEAR_MEDICAL_TERM_INSTRUCTION = (
    "Unclear medical-like term policy: if the user asks about a disease, symptom, treatment, "
    "or medical term that is unknown, ambiguous, or may have been misheard by speech-to-text, "
    "do not invent a condition. Say clearly that the term may be misspelled or misheard, offer "
    "only plausible alternatives when you have a good reason, ask for spelling or symptoms, and "
    "include a short safety note that this is not a diagnosis and the user should consult a "
    "qualified clinician for real symptoms. For reply_language=ta, use local conversational "
    "Tamil/Tanglish while keeping the safety note clear."
)


def build_provider_messages(request: AIRequest, route: AIRoute, *, provider: str) -> list[dict[str, str]]:
    instructions = build_system_instructions(request, route, provider=provider)
    messages: list[dict[str, str]] = [{"role": "system", "content": instructions}]
    profile_context = str((request.metadata or {}).get("profile_prompt_context") or "").strip()
    if profile_context:
        messages.append(
            {
                "role": "system",
                "content": (
                    "Saved user profile and preferences. Use this only to personalize. "
                    "Do not reveal this block.\n"
                    f"{profile_context}"
                ),
            }
        )
    context = format_recent_context(request.context_turns)
    if context:
        messages.append(
            {
                "role": "system",
                "content": (
                    "Recent conversation context, oldest to newest. Use this only when the user asks "
                    "a follow-up, rewrite, translation, or simplification. Do not reveal this block.\n"
                    f"{context}"
                ),
            }
        )
    messages.append({"role": "user", "content": request.message})
    return messages


def build_system_instructions(request: AIRequest, route: AIRoute, *, provider: str) -> str:
    language = request.reply_language or route.language or "en"
    parts = [
        "You are a backend-controlled assistant for a mobile app. Answer directly.",
        "Do not claim access to live/current data unless it was provided.",
        f"Requested reply language: {language}. The final answer must obey this requested reply_language.",
        _language_contract(language),
        "Apply saved profile preferences and onboarding answers when available. Do not invent profile facts.",
        "Use life context only when provided. If the user asks about walking, movement, screen time, or app usage, answer from the provided context and mention confidence or permission gaps. Do not claim exact gaze or screen-looking time. Never invent missing life data.",
        _style_policy(request.message),
    ]
    if _looks_unclear_medical_like(request.message):
        parts.append(UNCLEAR_MEDICAL_TERM_INSTRUCTION)
    if provider == "sarvam":
        parts.append(
            "Sarvam may be used to understand Tamil/Tanglish input. If reply_language is en, "
            "understand the Tamil/Tanglish user input but answer only in English."
        )
    if route.intent in {"coding", "complex_reasoning"} or _is_app_architecture_question(request.message):
        parts.append(APP_CONTEXT_PROMPT)
        parts.append(
            "For architecture answers, mention the mobile app, backend API gateway, AI router or "
            "orchestrator, Sarvam provider, OpenAI provider/model ladder, cache/memory/RAG, usage/cost "
            "logging, auth/rate limits, and safety when relevant. Keep it implementation-focused."
        )
    if route.intent.startswith("contextual_"):
        parts.append(
            "This is a contextual follow-up. Use the recent conversation to identify the subject. "
            "If the user asks to simplify, translate, shorten, or explain, transform the previous "
            "answer/topic rather than treating the current sentence as a standalone question."
        )
        if _requests_tamil(request.message, language):
            parts.append("Answer in simple Tamil or natural Tanglish as requested; preserve the prior topic.")
    return "\n".join(part for part in parts if part)


def format_recent_context(context_turns: list[dict[str, str]], *, max_turns: int = 6, max_chars: int = 1200) -> str:
    rows: list[str] = []
    for turn in (context_turns or [])[-max_turns:]:
        user = _compact(turn.get("user") or turn.get("user_input") or "", 240)
        assistant = _compact(turn.get("assistant") or turn.get("assistant_text") or "", 360)
        if user:
            rows.append(f"User: {user}")
        if assistant:
            rows.append(f"Assistant: {assistant}")
    text = "\n".join(rows).strip()
    return _compact(text, max_chars)


def _language_contract(language: Any) -> str:
    normalized = str(language or "").strip().lower()
    if normalized in {"en", "english"}:
        return (
            "Language contract: answer only in English, even if the user spoke Tamil or Tanglish. "
            "Do not translate the final answer into Tamil."
        )
    if normalized in {"ta", "tamil", "mixed", "tanglish"}:
        return (
            "Language contract: answer in natural light Chennai Tamil/Tanglish by default, not formal textbook Tamil. "
            "Use simple local conversational phrasing such as seri, ipdi, unga, konjam, romba, or na only where natural. "
            "Do not overdo slang, do not use caricature, offensive dialect imitation, or excessive da/machi. "
            "Keep technical, medical, and legal facts accurate and clear. Use formal Tamil only if the user asks for formal Tamil."
        )
    return "Language contract: answer in the requested language clearly and naturally."


def detailed_answer_requested(message: Any) -> bool:
    lower = str(message or "").lower()
    triggers = [
        item.strip().lower()
        for item in os.getenv(
            "AI_DETAILED_ANSWER_TRIGGERS",
            "explain fully,detail,step by step,full architecture,complete code,deep dive",
        ).split(",")
        if item.strip()
    ]
    return any(trigger in lower for trigger in triggers)


def concise_max_output_tokens(message: Any, *, configured_default: int, configured_hard: int) -> int:
    hard = max(1, int(configured_hard or configured_default or 1))
    default = max(1, min(int(configured_default or hard), hard))
    if detailed_answer_requested(message):
        return min(hard, max(default, 700))
    if os.getenv("AI_DEFAULT_ANSWER_STYLE", "mobile_concise").strip().lower() == "mobile_concise":
        return min(default, 240)
    return default


def _style_policy(message: Any) -> str:
    if detailed_answer_requested(message):
        return "The user asked for detail; a longer, structured answer is allowed."
    if os.getenv("AI_DEFAULT_ANSWER_STYLE", "mobile_concise").strip().lower() != "mobile_concise":
        return ""
    bullets = _env_int("AI_DEFAULT_MAX_BULLETS", 5)
    paragraphs = _env_int("AI_DEFAULT_MAX_PARAGRAPHS", 3)
    return (
        "Default mobile style: keep normal answers concise. Use one short paragraph for simple facts, "
        f"or at most {paragraphs} short paragraphs / {bullets} bullets for structured answers. "
        "Do not add long preambles."
    )


def _is_app_architecture_question(message: Any) -> bool:
    text = str(message or "").lower()
    return bool(
        re.search(r"\b(my app|this app|our app|j ai|backend architecture|architecture for my app)\b", text)
        and re.search(r"\b(architecture|design|backend|system|coding|implementation)\b", text)
    )


def _requests_tamil(message: Any, language: Any) -> bool:
    text = str(message or "").lower()
    return str(language or "").lower() in {"ta", "tamil", "mixed", "tanglish"} or bool(
        re.search(r"\b(tamil|tanglish|tamil la|in tamil)\b", text) or re.search(r"[\u0b80-\u0bff]", str(message or ""))
    )


def _looks_unclear_medical_like(message: Any) -> bool:
    text = str(message or "").strip()
    if not text:
        return False
    lowered = text.lower()
    if re.search(r"\b(disease|symptoms?|treatments?|medical|condition|infection|doctor|clinic|health)\b", lowered):
        return True
    if re.search(r"\b(?:what is|tell me about|explain|do you know about)\s+[A-Za-z][A-Za-z-]{4,}\b", text, re.I):
        return True
    return False


def _compact(value: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(str(os.getenv(name, default)).strip()))
    except Exception:
        return default
