from __future__ import annotations

import hashlib
import json
import random
import re
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional

from openai import OpenAI

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
        output_text = getattr(response, "output_text", None)
        if output_text:
            return str(output_text).strip()

        collected: List[str] = []
        for item in getattr(response, "output", None) or []:
            for part in getattr(item, "content", None) or []:
                text = getattr(part, "text", None)
                if text:
                    collected.append(str(text))
                elif isinstance(part, dict) and part.get("text"):
                    collected.append(str(part["text"]))
        return "\n".join(chunk.strip() for chunk in collected if str(chunk).strip()).strip()

    @staticmethod
    def _contains_health_risk(text: str) -> bool:
        normalized = str(text or "").lower()
        return any(keyword in normalized for keyword in HEALTH_RISK_KEYWORDS)

    def _cache_key(
        self,
        *,
        mode: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        max_output_tokens: int,
        schema_name: str = "",
        schema: Optional[Dict[str, Any]] = None,
    ) -> str:
        payload = {
            "mode": mode,
            "model": self.model,
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
    ) -> str:
        last_error: Optional[Exception] = None
        for attempt in range(1, OPENAI_MAX_RETRIES + 1):
            try:
                payload: Dict[str, Any] = {
                    "model": self.model,
                    "input": self._build_input(system_prompt, user_prompt),
                    "temperature": temperature,
                    "max_output_tokens": max_output_tokens,
                    "text": {"format": response_format or {"type": "text"}},
                }
                response = self.client.responses.create(**payload)
                text = self._extract_response_text(response)
                if not text:
                    raise RuntimeError("OpenAI returned empty output.")
                return text
            except Exception as exc:
                last_error = exc
                if attempt == OPENAI_MAX_RETRIES:
                    break
                sleep_seconds = min(
                    OPENAI_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)) + random.uniform(0.0, 0.25),
                    8.0,
                )
                time.sleep(sleep_seconds)
        raise RuntimeError(f"OpenAI request failed after {OPENAI_MAX_RETRIES} attempt(s): {last_error}")

    def generate_text(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        temperature: float = RAW_TEMPERATURE,
        max_output_tokens: int = 800,
    ) -> str:
        key = self._cache_key(
            mode="text",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        cached = self._cache_get(key)
        if cached is not None:
            return cached
        text = self._request_text(system_prompt, user_prompt, temperature=temperature, max_output_tokens=max_output_tokens)
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
    ) -> Dict[str, Any]:
        key = self._cache_key(
            mode="json",
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
        )
        parsed = self._repair_json(raw_json, schema_name, schema)
        serialized = json.dumps(parsed, ensure_ascii=False, sort_keys=True)
        self._cache_set(key, serialized)
        return parsed

    def answer_user_query_structured(self, user_query: str, profile_context: str) -> Dict[str, str]:
        health_sensitive = self._contains_health_risk(user_query) or self._contains_health_risk(profile_context)
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
        data = self.generate_json(system_prompt, user_prompt, "core_answer_result", schema, temperature=RAW_TEMPERATURE, max_output_tokens=1000)
        answer = str(data.get("answer", "")).strip() or self.answer_user_query(user_query, profile_context)
        return {
            "answer": answer,
            "answer_style": str(data.get("answer_style", "practical")).strip() or "practical",
            "risk_level": str(data.get("risk_level", "low")).strip() or "low",
            "safety_notes": str(data.get("safety_notes", "")).strip() or safety_block,
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
        data = self.generate_json(system_prompt, user_prompt, "answer_review", schema, temperature=REVIEW_TEMPERATURE, max_output_tokens=900)
        keep_original = str(data.get("keep_original", "true")).strip().lower()
        final_answer = answer if keep_original == "true" else (str(data.get("final_answer", "")).strip() or answer)
        return {
            "final_answer": final_answer,
            "keep_original": keep_original,
            "review_note": str(data.get("review_note", "")).strip(),
        }