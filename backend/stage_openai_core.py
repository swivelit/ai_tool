from __future__ import annotations

import hashlib
import json
import random
import re
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

from openai import (
    APIConnectionError,
    APITimeoutError,
    APIStatusError,
    AuthenticationError,
    BadRequestError,
    ConflictError,
    InternalServerError,
    NotFoundError,
    OpenAI,
    PermissionDeniedError,
    RateLimitError,
    UnprocessableEntityError,
)

from config import (
    ENABLE_ANSWER_REVIEW,
    ENABLE_HEALTH_SAFETY_GUARD,
    HEALTH_RISK_KEYWORDS,
    MEDICAL_SAFETY_NOTE,
    OPENAI_API_KEY,
    OPENAI_BACKOFF_BASE_SECONDS,
    OPENAI_CACHE_SIZE,
    OPENAI_JSON_REPAIR_ATTEMPTS,
    OPENAI_MAX_RETRIES,
    OPENAI_MODEL,
    OPENAI_TIMEOUT,
    RAW_TEMPERATURE,
    REVIEW_TEMPERATURE,
)

try:
    from app.openai_model_router import OpenAIModelRouter
except Exception:  # pragma: no cover
    OpenAIModelRouter = None  # type: ignore


_RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
_RETRYABLE_EXCEPTIONS = (
    RateLimitError,
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
)
_NON_RETRYABLE_EXCEPTIONS = (
    BadRequestError,
    AuthenticationError,
    PermissionDeniedError,
    NotFoundError,
    ConflictError,
    UnprocessableEntityError,
)

_CONTEXTUAL_HEALTH_RISK_TERMS = {"heart", "medicine", "tablet", "dose", "dosage"}
_CONTEXTUAL_HEALTH_ADJACENT_TERMS = {
    "diet",
    "food",
    "eat",
    "eating",
    "nutrition",
    "exercise",
    "workout",
    "sleep",
    "pain",
    "heart",
    "medicine",
    "medication",
    "tablet",
    "dose",
    "dosage",
}
_HEALTH_ADJACENT_TERMS = {
    "health",
    "medical",
    "doctor",
    "clinic",
    "hospital",
    "symptom",
    "symptoms",
    "diagnosis",
    "diagnose",
    "treatment",
    "prescription",
    "medication",
    "pregnant",
    "pregnancy",
    "allergy",
    "allergic",
    "fever",
}
_BODY_PART_TERMS = (
    "stomach",
    "abdomen",
    "abdominal",
    "chest",
    "head",
    "back",
    "neck",
    "throat",
    "ear",
    "tooth",
    "teeth",
    "leg",
    "arm",
    "hand",
    "foot",
    "feet",
    "knee",
    "shoulder",
    "hip",
    "joint",
    "muscle",
)
_HEART_HEALTH_CONTEXT_RE = re.compile(
    r"\b(?:"
    r"heart\s+(?:attack|disease|condition|failure|rate|palpitations?|symptoms?)|"
    r"symptoms?\s+of\s+(?:a\s+)?heart\s+attack"
    r")\b"
)
_MEDICATION_HEALTH_CONTEXT_RE = re.compile(
    r"\b(?:"
    r"(?:what|which|safe|recommended|correct)\s+(?:dose|dosage)\b|"
    r"(?:dose|dosage)\s+of\s+(?:this\s+)?(?:medicine|medication|tablet)\b|"
    r"(?:can|should)\s+i\s+take\s+(?:this\s+)?(?:medicine|medication|tablet)\b|"
    r"(?:take|taking)\s+(?:this\s+)?(?:medicine|medication|tablet)\b|"
    r"(?:medicine|medication|tablet)\s+(?:dose|dosage|side\s+effects?|for|with)\b"
    r")"
)
_PERSONAL_DIET_CONTEXT_RE = re.compile(
    r"\b(?:"
    r"what\s+(?:should|can)\s+i\s+eat|"
    r"can\s+i\s+eat|"
    r"foods?\s+(?:should|can)\s+i|"
    r"(?:my\s+)?(?:diet|meal)\s+plan|"
    r"(?:breakfast|lunch|dinner)\s+(?:plan|ideas?|for\s+me)|"
    r"nutrition\s+(?:advice|plan|for\s+me)"
    r")\b"
)
_PERSONAL_EXERCISE_CONTEXT_RE = re.compile(
    r"\b(?:"
    r"(?:can|should)\s+i\s+(?:exercise|work\s*out)|"
    r"(?:my\s+)?(?:exercise|workout)\s+(?:plan|routine|advice)|"
    r"(?:exercise|workout)\s+for\s+me"
    r")\b"
)
_SLEEP_HEALTH_CONTEXT_RE = re.compile(
    r"\b(?:"
    r"(?:i\s+)?(?:can(?:not|'t)|cant|unable\s+to|struggling\s+to)\s+sleep|"
    r"sleep(?:ing)?\s+(?:problem|problems|trouble|difficulty|disorder)|"
    r"insomnia|sleepless"
    r")\b"
)
_PAIN_HEALTH_CONTEXT_RE = re.compile(
    rf"\b(?:{'|'.join(_BODY_PART_TERMS)})\s+(?:pain|ache|aches|hurts?)\b|"
    rf"\b(?:pain|ache|aches|hurts?)\s+(?:in|near|around|inside)\s+(?:my\s+|the\s+)?(?:{'|'.join(_BODY_PART_TERMS)})\b|"
    r"\bi\s+(?:have|feel|am\s+in|am\s+having)\s+(?:[a-z0-9_]+\s+){0,3}(?:pain|ache|aches|hurt|hurts)\b"
)


def _status_code_from_exception(exc: BaseException) -> Optional[int]:
    status_code = getattr(exc, "status_code", None)
    try:
        return int(status_code) if status_code is not None else None
    except Exception:
        return None


def _is_retryable_exception(exc: BaseException) -> bool:
    if isinstance(exc, _NON_RETRYABLE_EXCEPTIONS):
        return False
    if isinstance(exc, _RETRYABLE_EXCEPTIONS):
        return True
    if isinstance(exc, APIStatusError):
        return (_status_code_from_exception(exc) or 0) in _RETRYABLE_STATUS_CODES

    status_code = _status_code_from_exception(exc)
    if status_code is not None:
        return status_code in _RETRYABLE_STATUS_CODES

    return False


class OpenAICore:
    """OpenAI wrapper with retry, cache, JSON parsing, and safety-aware prompting."""

    def __init__(self, model: str = OPENAI_MODEL) -> None:
        if not OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is missing. Add it to .env before running the pipeline.")
        self.model = model
        self.client = OpenAI(api_key=OPENAI_API_KEY, timeout=OPENAI_TIMEOUT)
        self._cache: "OrderedDict[str, str]" = OrderedDict()

    @staticmethod
    def _build_input(system_prompt: str, user_prompt: str) -> List[Dict[str, str]]:
        return [
            {"role": "system", "content": system_prompt.strip()},
            {"role": "user", "content": user_prompt.strip()},
        ]

    @staticmethod
    def _strip_json_fences(text: str) -> str:
        stripped = str(text or "").strip()
        if stripped.startswith("```"):
            stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
            stripped = re.sub(r"\s*```$", "", stripped)
        return stripped.strip()

    @staticmethod
    def _extract_response_text(response: Any) -> str:
        """Safely extracts text from a standard OpenAI ChatCompletion response."""
        try:
            if hasattr(response, "choices") and response.choices:
                message = response.choices[0].message
                content = getattr(message, "content", "")
                if isinstance(content, str):
                    return content.strip()
                if isinstance(content, list):
                    parts: List[str] = []
                    for item in content:
                        if isinstance(item, dict) and item.get("type") == "text":
                            parts.append(str(item.get("text", "")))
                        elif hasattr(item, "type") and getattr(item, "type") == "text":
                            parts.append(str(getattr(item, "text", "")))
                    return "".join(parts).strip()
        except Exception:
            pass
        return ""

    @staticmethod
    def _normalize_response_format(response_format: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not response_format:
            return {"type": "text"}

        if response_format.get("type") == "json_schema":
            json_schema = response_format.get("json_schema")
            if isinstance(json_schema, dict):
                return {"type": "json_schema", "json_schema": json_schema}

            schema_name = response_format.get("name")
            schema = response_format.get("schema")
            if not schema_name or not isinstance(schema, dict):
                raise ValueError("json_schema response_format requires 'name' and 'schema'.")

            return {
                "type": "json_schema",
                "json_schema": {
                    "name": str(schema_name),
                    "strict": bool(response_format.get("strict", True)),
                    "schema": schema,
                },
            }

        return response_format

    @staticmethod
    def _normalize_health_text(text: str) -> str:
        normalized = str(text or "").lower()
        normalized = re.sub(r"[^\w\s\u0B80-\u0BFF]", " ", normalized)
        return re.sub(r"\s+", " ", normalized).strip()

    @staticmethod
    def _contains_any_health_term(text: str, terms: set[str]) -> bool:
        haystack = OpenAICore._normalize_health_text(text)
        for raw_term in terms:
            term = OpenAICore._normalize_health_text(raw_term)
            if not term:
                continue
            if re.search(rf"(?<![a-z0-9_]){re.escape(term)}(?![a-z0-9_])", haystack):
                return True
        return False

    @classmethod
    def _contains_health_risk(cls, text: str) -> bool:
        normalized = str(text or "").lower()
        non_contextual_terms = set(HEALTH_RISK_KEYWORDS) - _CONTEXTUAL_HEALTH_RISK_TERMS
        if cls._contains_any_health_term(normalized, non_contextual_terms):
            return True
        return (
            _HEART_HEALTH_CONTEXT_RE.search(cls._normalize_health_text(normalized)) is not None
            or _MEDICATION_HEALTH_CONTEXT_RE.search(cls._normalize_health_text(normalized)) is not None
        )

    @classmethod
    def _is_health_adjacent_query(cls, text: str) -> bool:
        normalized = cls._normalize_health_text(text)
        if cls._contains_health_risk(normalized):
            return True

        # Do not treat broad words such as food, pain, sleep, or exercise as
        # medical by themselves. They are common in business/software prompts
        # (for example, "food startup", "pain points", "sleep mode",
        # "Python exercise"). Only profile medical facts should influence the
        # core prompt when the current turn has an actual health context.
        always_health_adjacent = _HEALTH_ADJACENT_TERMS - _CONTEXTUAL_HEALTH_ADJACENT_TERMS
        if cls._contains_any_health_term(normalized, always_health_adjacent):
            return True

        return (
            _HEART_HEALTH_CONTEXT_RE.search(normalized) is not None
            or _MEDICATION_HEALTH_CONTEXT_RE.search(normalized) is not None
            or _SLEEP_HEALTH_CONTEXT_RE.search(normalized) is not None
            or _PAIN_HEALTH_CONTEXT_RE.search(normalized) is not None
            or _PERSONAL_DIET_CONTEXT_RE.search(normalized) is not None
            or _PERSONAL_EXERCISE_CONTEXT_RE.search(normalized) is not None
        )

    def _cache_key(
        self,
        *,
        mode: str,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        max_output_tokens: int,
        schema_name: str = "",
        schema: Optional[Dict[str, Any]] = None,
    ) -> str:
        payload = {
            "mode": mode,
            "model": model,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "temperature": temperature,
            "max_output_tokens": max_output_tokens,
            "schema_name": schema_name,
            "schema": schema or {},
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def _cache_get(self, key: str) -> Optional[str]:
        value = self._cache.get(key)
        if value is None:
            return None
        self._cache.move_to_end(key)
        return value

    def _cache_set(self, key: str, value: str) -> None:
        self._cache[key] = value
        self._cache.move_to_end(key)
        while len(self._cache) > OPENAI_CACHE_SIZE:
            self._cache.popitem(last=False)

    def _request_text(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float,
        max_output_tokens: int,
        response_format: Optional[Dict[str, Any]] = None,
        model_override: Optional[str] = None,
    ) -> str:
        model = str(model_override or self.model).strip() or self.model
        last_error: Optional[Exception] = None
        for attempt in range(1, OPENAI_MAX_RETRIES + 1):
            try:
                response = self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt.strip()},
                        {"role": "user", "content": user_prompt.strip()},
                    ],
                    temperature=temperature,
                    max_tokens=max_output_tokens,
                    response_format=self._normalize_response_format(response_format),
                )
                text = self._extract_response_text(response)
                if not text:
                    raise RuntimeError("OpenAI returned empty output.")
                return text
            except Exception as exc:
                last_error = exc
                retryable = _is_retryable_exception(exc)
                if not retryable or attempt == OPENAI_MAX_RETRIES:
                    break
                sleep_seconds = min(
                    OPENAI_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)) + random.uniform(0.0, 0.25),
                    8.0,
                )
                time.sleep(sleep_seconds)

        if last_error is not None:
            raise last_error
        raise RuntimeError("OpenAI request failed without returning a response.")

    def generate_text(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float = RAW_TEMPERATURE,
        max_output_tokens: int = 800,
        model_override: Optional[str] = None,
    ) -> str:
        model = str(model_override or self.model).strip() or self.model
        key = self._cache_key(
            mode="text",
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        cached = self._cache_get(key)
        if cached is not None:
            return cached
        text = self._request_text(
            system_prompt,
            user_prompt,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            model_override=model,
        )
        self._cache_set(key, text)
        return text

    def _repair_json(self, raw_text: str, schema_name: str, schema: Dict[str, Any]) -> Dict[str, Any]:
        cleaned = self._strip_json_fences(raw_text)
        try:
            return json.loads(cleaned)
        except Exception:
            pass

        if OPENAI_JSON_REPAIR_ATTEMPTS <= 0:
            raise

        repair_prompt = (
            "Repair the following content into valid JSON that exactly fits the provided schema. "
            "Return JSON only, with no markdown fences."
        )
        repaired = self._request_text(
            repair_prompt,
            f"Schema name: {schema_name}\nSchema: {json.dumps(schema, ensure_ascii=False)}\n\nBroken content:\n{cleaned}",
            temperature=0.0,
            max_output_tokens=1200,
            response_format={"type": "json_schema", "name": schema_name, "strict": True, "schema": schema},
        )
        return json.loads(self._strip_json_fences(repaired))

    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        schema_name: str,
        schema: Dict[str, Any],
        *,
        temperature: float = 0.2,
        max_output_tokens: int = 1200,
        model_override: Optional[str] = None,
    ) -> Dict[str, Any]:
        model = str(model_override or self.model).strip() or self.model
        key = self._cache_key(
            mode="json",
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            schema_name=schema_name,
            schema=schema,
        )
        cached = self._cache_get(key)
        if cached is not None:
            return json.loads(cached)

        raw_json = self._request_text(
            system_prompt,
            user_prompt,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            response_format={"type": "json_schema", "name": schema_name, "strict": True, "schema": schema},
            model_override=model,
        )
        parsed = self._repair_json(raw_json, schema_name, schema)
        serialized = json.dumps(parsed, ensure_ascii=False, sort_keys=True)
        self._cache_set(key, serialized)
        return parsed

    def answer_user_query_structured(self, user_query: str, profile_context: str) -> Dict[str, str]:
        router = OpenAIModelRouter() if OpenAIModelRouter is not None else None
        selection = router.select_model(
            "normal_qa",
            user_query,
            risk_level="high" if self._contains_health_risk(user_query) else "low",
        ) if router is not None else None
        query_health_sensitive = self._contains_health_risk(user_query)
        profile_health_relevant = self._contains_health_risk(profile_context) and self._is_health_adjacent_query(user_query)
        health_sensitive = query_health_sensitive or profile_health_relevant
        safety_block = MEDICAL_SAFETY_NOTE if ENABLE_HEALTH_SAFETY_GUARD and health_sensitive else ""
        system_prompt = (
            "You are the English core answer engine for a persona-aware assistant. "
            "Answer in clear, practical English. Respect the profile context. "
            "Do not mention hidden profiling or internal system details."
        )
        schema = {
            "type": "object",
            "properties": {
                "answer": {"type": "string"},
                "answer_style": {"type": "string"},
                "risk_level": {"type": "string", "enum": ["low", "medium", "high"]},
                "safety_notes": {"type": "string"},
            },
            "required": ["answer", "answer_style", "risk_level", "safety_notes"],
            "additionalProperties": False,
        }
        user_prompt = f"""
User profile context:
{profile_context}

User question:
{user_query}

Additional safety instruction:
{safety_block}

Task:
1. Answer helpfully and directly.
2. Prefer practical wording.
3. Keep the answer faithful to the profile context.
4. Avoid invented facts.
5. If the query is medically sensitive, stay cautious and recommend professional care for urgent or medication-related issues.
6. Output JSON following the schema.
""".strip()
        data = self.generate_json(
            system_prompt,
            user_prompt,
            "core_answer_result",
            schema,
            temperature=RAW_TEMPERATURE,
            max_output_tokens=min(1000, selection.max_output_tokens) if selection is not None else 1000,
            model_override=selection.model if selection is not None else None,
        )
        answer = str(data.get("answer", "")).strip() or self.answer_user_query(user_query, profile_context)
        return {
            "answer": answer,
            "answer_style": str(data.get("answer_style", "practical")).strip() or "practical",
            "risk_level": str(data.get("risk_level", "low")).strip() or "low",
            "safety_notes": str(data.get("safety_notes", "")).strip() or safety_block,
            "model_used": selection.model if selection is not None else self.model,
            "model_tier": selection.tier if selection is not None else "standard",
            "model_reason": selection.reason if selection is not None else "legacy_default",
            "estimated_input_tokens": selection.estimated_input_tokens if selection is not None else 0,
            "estimated_output_tokens": selection.estimated_output_tokens if selection is not None else 0,
            "estimated_cost_usd": selection.estimated_cost_usd if selection is not None else 0.0,
        }

    def answer_user_query(self, user_query: str, profile_context: str) -> str:
        system_prompt = (
            "You are the English core answer engine for a persona-aware assistant. "
            "Answer in clear, practical English. Respect the user profile and safety context."
        )
        user_prompt = f"""
User profile context:
{profile_context}

User question:
{user_query}

Task:
1. Answer helpfully.
2. Prefer practical and easy-to-understand wording.
3. Avoid invented facts.
4. Output only the answer text in English.
""".strip()
        return self.generate_text(system_prompt, user_prompt, temperature=RAW_TEMPERATURE)

    def review_answer(self, user_query: str, answer: str, profile_context: str) -> Dict[str, str]:
        if not ENABLE_ANSWER_REVIEW:
            return {"final_answer": answer, "keep_original": "true", "review_note": "review disabled"}
        router = OpenAIModelRouter() if OpenAIModelRouter is not None else None
        selection = router.select_model("review", user_query) if router is not None else None

        schema = {
            "type": "object",
            "properties": {
                "final_answer": {"type": "string"},
                "keep_original": {"type": "string", "enum": ["true", "false"]},
                "review_note": {"type": "string"},
            },
            "required": ["final_answer", "keep_original", "review_note"],
            "additionalProperties": False,
        }
        system_prompt = (
            "You are a strict answer reviewer. Improve the answer only if it becomes safer, clearer, more concise, "
            "or more faithful to the user context. Do not add new facts."
        )
        user_prompt = f"""
User profile context:
{profile_context}

User question:
{user_query}

Candidate answer:
{answer}

Task:
- Keep the answer if it is already strong.
- Revise only when needed for clarity, tone, or safety.
- Do not invent facts.
- Output JSON following the schema.
""".strip()
        data = self.generate_json(
            system_prompt,
            user_prompt,
            "answer_review",
            schema,
            temperature=REVIEW_TEMPERATURE,
            max_output_tokens=min(900, selection.max_output_tokens) if selection is not None else 900,
            model_override=selection.model if selection is not None else None,
        )
        keep_original = str(data.get("keep_original", "true")).strip().lower()
        final_answer = answer if keep_original == "true" else (str(data.get("final_answer", "")).strip() or answer)
        return {
            "final_answer": final_answer,
            "keep_original": keep_original,
            "review_note": str(data.get("review_note", "")).strip(),
            "model_used": selection.model if selection is not None else self.model,
            "model_tier": selection.tier if selection is not None else "standard",
            "model_reason": selection.reason if selection is not None else "legacy_default",
            "estimated_input_tokens": selection.estimated_input_tokens if selection is not None else 0,
            "estimated_output_tokens": selection.estimated_output_tokens if selection is not None else 0,
            "estimated_cost_usd": selection.estimated_cost_usd if selection is not None else 0.0,
        }
