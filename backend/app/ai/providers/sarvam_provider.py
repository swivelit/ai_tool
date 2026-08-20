from __future__ import annotations

import os
import re
import subprocess
import time
import wave
import logging
from pathlib import Path
from typing import Any, Callable, Optional

import requests
from fastapi import HTTPException

from ...observability import chat_log_payload
from ...openai_model_router import OpenAIModelRouter
from ..prompts import build_provider_messages, serialize_provider_messages
from ..types import AIProviderResponse, AIRequest, AIRoute
from .base import AIProvider, GenerationCancellation, GenerationCancelled


logger = logging.getLogger(__name__)
# Provider lifecycle events are intentionally INFO-level operational records.
# Keep this child logger explicit so unrelated app.ai verbosity settings do not
# suppress STT/TTS completion and failure audit events.
logger.setLevel(logging.INFO)


SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech"
SARVAM_TTS_MODEL_DEFAULT = "bulbul:v2"
SARVAM_TTS_DEFAULT_MODEL = SARVAM_TTS_MODEL_DEFAULT
SARVAM_TTS_DEFAULT_PREMIUM_MODEL = "bulbul:v3"
SARVAM_TTS_SPEAKER_EN_DEFAULT = "anushka"
SARVAM_TTS_SPEAKER_TA_DEFAULT = "karun"
SARVAM_TTS_PACE_EN_DEFAULT = "0.95"
SARVAM_TTS_PACE_TA_DEFAULT = "0.9"
SARVAM_TTS_LOCALE_STYLE_EN = "indian_english"
SARVAM_TTS_LOCALE_STYLE_TA = "local_tamil"
SARVAM_TTS_DEFAULT_SPEAKER = SARVAM_TTS_SPEAKER_EN_DEFAULT
SARVAM_TTS_BULBUL_V2_SPEAKERS = {
    "anushka",
    "abhilash",
    "manisha",
    "vidya",
    "arya",
    "karun",
    "hitesh",
}
SARVAM_STT_EMPTY_TRANSCRIPT_DETAIL = (
    "No speech was detected in the uploaded audio. Hold the mic until recording starts, then speak for at least a second."
)
SARVAM_STT_MODES = frozenset({"transcribe", "translate", "verbatim", "translit", "codemix"})
WEB_STT_MODES = frozenset({"transcribe", "translit"})
SARVAM_STT_ACCEPTED_UPLOAD_MIME_TYPES = {
    "application/octet-stream",
    "audio/aac",
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
}
_MOBILE_AUDIO_UPLOAD_MIME_TYPES = {
    "",
    "audio/m4a",
    "audio/mp4",
    "audio/x-m4a",
    "application/mp4",
}


def normalize_sarvam_stt_mode(value: str | None, *, website: bool = False) -> str:
    """Keep shared Sarvam modes broad while constraining the web policy."""

    configured = str(value or "transcribe").strip().lower() or "transcribe"
    allowed = WEB_STT_MODES if website else SARVAM_STT_MODES
    return configured if configured in allowed else "transcribe"


def _extract_chat_usage(raw: Any) -> dict[str, int]:
    usage = getattr(raw, "usage", None)
    if usage is None and isinstance(raw, dict):
        usage = raw.get("usage")
    if usage is None:
        return {}

    def value(*names: str) -> int:
        for name in names:
            found = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)
            if found is not None:
                try:
                    return max(0, int(found))
                except Exception:
                    pass
        return 0

    result = {
        "input_tokens": value("prompt_tokens", "input_tokens"),
        "output_tokens": value("completion_tokens", "output_tokens"),
        "cached_input_tokens": value("cached_input_tokens", "cached_tokens"),
        "cache_write_tokens": value("cache_write_tokens", "cache_creation_input_tokens"),
    }
    return result if result["input_tokens"] or result["output_tokens"] else {}


def _sarvam_finish_metadata(raw: Any) -> dict[str, Any]:
    choices = raw.get("choices") if isinstance(raw, dict) else getattr(raw, "choices", None)
    choice = choices[0] if choices else None
    finish = choice.get("finish_reason") if isinstance(choice, dict) else getattr(choice, "finish_reason", None)
    status = raw.get("status") if isinstance(raw, dict) else getattr(raw, "status", None)
    normalized = str(finish or "").strip().lower()
    if normalized in {"max_tokens", "max_output_tokens", "length"}:
        normalized = "length"
    elif normalized in {"completed", "complete", "end_turn"}:
        normalized = "stop"
    elif not normalized:
        normalized = "unknown"
    raw_status = str(status or "").strip().lower()
    completion_status = (
        "complete" if raw_status in {"complete", "completed", "success", "succeeded"}
        else "incomplete" if raw_status in {"incomplete", "truncated"}
        else "failed" if raw_status in {"failed", "error"}
        else "incomplete" if normalized == "length"
        else "complete" if normalized == "stop"
        else "unknown"
    )
    return {
        "finish_reason": normalized,
        "truncated": normalized == "length",
        "completion_status": completion_status,
    }


def normalize_sarvam_tts_model(model: str | None, premium: bool = False) -> str:
    value = str(model or "").strip()
    if value:
        return value
    return SARVAM_TTS_DEFAULT_PREMIUM_MODEL if premium else SARVAM_TTS_DEFAULT_MODEL


def normalize_sarvam_tts_language_code(target_language_code: str | None, *, fallback_reply_language: str | None = None) -> str:
    value = str(target_language_code or "").strip().lower()
    fallback = str(fallback_reply_language or "").strip().lower()
    if value in {"ta", "ta-in", "tamil", "tanglish"}:
        return "ta-IN"
    if value in {"en", "en-in", "english"}:
        return "en-IN"
    if fallback in {"ta", "ta-in", "tamil", "mixed", "tanglish"}:
        return "ta-IN"
    return "en-IN"


def _language_default_speaker(language_code: str) -> str:
    if language_code == "ta-IN":
        return (
            os.getenv("SARVAM_TTS_SPEAKER_TA", "").strip()
            or os.getenv("SARVAM_TTS_SPEAKER", "").strip()
            or SARVAM_TTS_SPEAKER_TA_DEFAULT
        )
    return (
        os.getenv("SARVAM_TTS_SPEAKER_EN", "").strip()
        or os.getenv("SARVAM_TTS_SPEAKER", "").strip()
        or SARVAM_TTS_SPEAKER_EN_DEFAULT
    )


def _language_fallback_speaker(language_code: str) -> str:
    return SARVAM_TTS_SPEAKER_TA_DEFAULT if language_code == "ta-IN" else SARVAM_TTS_SPEAKER_EN_DEFAULT


def _language_default_pace(language_code: str) -> str:
    if language_code == "ta-IN":
        return os.getenv("SARVAM_TTS_PACE_TA", "").strip() or SARVAM_TTS_PACE_TA_DEFAULT
    return os.getenv("SARVAM_TTS_PACE_EN", "").strip() or SARVAM_TTS_PACE_EN_DEFAULT


def _language_locale_style(language_code: str) -> str:
    return SARVAM_TTS_LOCALE_STYLE_TA if language_code == "ta-IN" else SARVAM_TTS_LOCALE_STYLE_EN


def _safe_float(value: str) -> float | None:
    try:
        return float(str(value).strip())
    except Exception:
        return None


def resolve_sarvam_tts_voice(target_language_code: str, requested_speaker: str | None = None) -> dict[str, Any]:
    language_code = normalize_sarvam_tts_language_code(target_language_code)
    model = normalize_sarvam_tts_model(os.getenv("SARVAM_TTS_MODEL"), premium=False)
    requested = str(requested_speaker or "").strip().lower() or _language_default_speaker(language_code).lower()
    fallback = _language_fallback_speaker(language_code)
    speaker = requested
    if model.strip().lower() == SARVAM_TTS_MODEL_DEFAULT and speaker not in SARVAM_TTS_BULBUL_V2_SPEAKERS:
        speaker = fallback
    if model.strip().lower() == SARVAM_TTS_MODEL_DEFAULT and speaker not in SARVAM_TTS_BULBUL_V2_SPEAKERS:
        speaker = SARVAM_TTS_SPEAKER_EN_DEFAULT

    pace = _safe_float(_language_default_pace(language_code))
    result: dict[str, Any] = {
        "speaker": speaker,
        "target_language_code": language_code,
        "style": _language_locale_style(language_code),
    }
    if pace is not None:
        result["pace"] = pace
    return result


def resolve_sarvam_tts_speaker(model: str, requested_speaker: str | None = None) -> str:
    requested = str(requested_speaker or "").strip().lower()
    if not requested:
        requested = SARVAM_TTS_DEFAULT_SPEAKER

    if str(model or "").strip().lower() == SARVAM_TTS_DEFAULT_MODEL and requested not in SARVAM_TTS_BULBUL_V2_SPEAKERS:
        return SARVAM_TTS_DEFAULT_SPEAKER

    return requested


def parse_sarvam_available_speakers(error_text: str) -> list[str]:
    text = str(error_text or "")
    match = re.search(
        r"available speakers(?:\s+for\s+[A-Za-z0-9:._-]+)?\s*(?:are|:)\s*:?\s*([^\n.]+)",
        text,
        re.IGNORECASE,
    )
    if not match:
        return []

    speakers: list[str] = []
    for raw in re.split(r",|;|/|\band\b", match.group(1), flags=re.IGNORECASE):
        speaker = re.sub(r"[^A-Za-z0-9_-]+", "", raw.strip().lower())
        if speaker and speaker not in speakers:
            speakers.append(speaker)
    return speakers


def is_sarvam_speaker_incompatible_error(error_text: str) -> bool:
    normalized = str(error_text or "").lower()
    return (
        "speaker" in normalized
        and ("not compatible" in normalized or "incompatible" in normalized)
    ) or ("speaker" in normalized and "available speakers" in normalized)


class SarvamProvider(AIProvider):
    def __init__(
        self,
        client: Optional[Any] = None,
        *,
        client_factory: Optional[Callable[[], Any]] = None,
        http_post: Optional[Callable[..., Any]] = None,
        api_key_getter: Optional[Callable[[], str]] = None,
        cache_recorder: Optional[Callable[[AIRequest, AIRoute, AIProviderResponse], Any]] = None,
    ) -> None:
        self._client = client
        self._client_factory = client_factory
        self._http_post = http_post or requests.post
        self._api_key_getter = api_key_getter
        self._cache_recorder = cache_recorder
        self.last_stt_detected_language: Optional[str] = None

    def _api_key(self) -> str:
        if self._api_key_getter is not None:
            return str(self._api_key_getter() or "").strip()
        return os.getenv("SARVAM_API_KEY", "").strip()

    def _client_or_create(self) -> Any:
        if self._client is not None:
            return self._client
        if self._client_factory is not None:
            self._client = self._client_factory()
            return self._client
        api_key = self._api_key()
        if not api_key:
            raise HTTPException(status_code=503, detail="SARVAM_API_KEY is not configured.")
        try:
            from sarvamai import SarvamAI
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail="Sarvam SDK is not installed. Install sarvamai to use Sarvam chat.",
            ) from exc
        self._client = SarvamAI(api_subscription_key=api_key)
        return self._client

    def complete(self, request: AIRequest, route: AIRoute) -> AIProviderResponse:
        client = self._client_or_create()
        messages = build_provider_messages(request, route, provider="sarvam")
        raw = self._call_chat(client, route.model or chat_model_for_intent(route.intent), messages, route.max_output_tokens)
        text = _extract_chat_text(raw)
        if not text.strip():
            exc = HTTPException(status_code=502, detail="Sarvam chat returned empty text.")
            exc.metadata = {"provider_error_type": "empty_sarvam_response"}  # type: ignore[attr-defined]
            raise exc
        usage = _extract_chat_usage(raw)
        prompt_tokens = int(request.metadata.get("estimated_prompt_tokens") or OpenAIModelRouter.estimate_tokens(serialize_provider_messages(messages)))
        input_tokens = int(usage.get("input_tokens") or prompt_tokens)
        output_tokens = int(usage.get("output_tokens") or OpenAIModelRouter.estimate_tokens(text))
        cost = estimate_sarvam_chat_cost(route.model or "", input_tokens, output_tokens)
        response = AIProviderResponse(
            text=text,
            provider="sarvam",
            model=route.model,
            route=route.route,
            reason=route.reason,
            language=route.language,
            intent=route.intent,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            characters=len(text or ""),
            estimated_cost_amount=cost,
            estimated_cost_currency="INR",
            raw={
                "sdk_response_type": raw.__class__.__name__,
                "reply_language": request.reply_language or route.language,
                "input_language": route.metadata.get("input_language") or request.metadata.get("input_language") or "",
                "profile_context_included": bool(request.metadata.get("profile_prompt_context")),
                "original_message": route.metadata.get("original_message") or request.message,
                "normalized_message": route.metadata.get("normalized_message") or request.message,
                "stripped_wake_word": bool(route.metadata.get("stripped_wake_word")),
                "stripped_prefix": route.metadata.get("stripped_prefix") or "",
                "intent_before_cleanup": route.metadata.get("intent_before_cleanup") or route.intent,
                "intent_after_cleanup": route.metadata.get("intent_after_cleanup") or route.intent,
                "usage_actual": bool(usage),
                "cached_input_tokens": int(usage.get("cached_input_tokens") or 0),
                "cache_write_tokens": int(usage.get("cache_write_tokens") or 0),
                "provider_attempts": 1,
                "provider_calls_with_usage": 1 if usage else 0,
                **_sarvam_finish_metadata(raw),
            },
        )
        if self._cache_recorder is not None:
            self._cache_recorder(request, route, response)
        return response

    def stream_complete(
        self, request: AIRequest, route: AIRoute, on_delta: Callable[[str], None]
    ) -> AIProviderResponse:
        client = self._client_or_create()
        cancellation = request.metadata.get("cancellation_signal")
        if not isinstance(cancellation, GenerationCancellation):
            cancellation = None
        if cancellation and cancellation.cancelled:
            raise GenerationCancelled()
        messages = build_provider_messages(request, route, provider="sarvam")
        prompt_tokens = int(request.metadata.get("estimated_prompt_tokens") or OpenAIModelRouter.estimate_tokens(serialize_provider_messages(messages)))
        max_attempts = min(2, max(1, int(request.metadata.get("max_provider_attempts") or 2)))
        completions = getattr(getattr(client, "chat", None), "completions", None)
        create = getattr(completions, "create", None)
        caller = completions if callable(completions) else create
        if not callable(caller):
            return self.complete(request, route)
        try:
            stream = caller(
                model=route.model or chat_model_for_intent(route.intent), messages=messages,
                max_tokens=route.max_output_tokens, temperature=0.2, stream=True,
            )
        except TypeError:
            if cancellation and cancellation.cancelled:
                raise GenerationCancelled()
            if max_attempts < 2:
                raise HTTPException(status_code=502, detail="Sarvam streaming is unsupported.")
            response = self.complete(request, route)
            response.raw["provider_attempts"] = 2
            response.raw["fallback_attempted"] = True
            on_delta(response.text)
            return response
        if cancellation:
            cancellation.bind_stream(stream)
        parts: list[str] = []
        final_usage: dict[str, int] = {}
        finish_metadata: dict[str, Any] = {
            "finish_reason": "unknown", "truncated": False,
            "completion_status": "unknown",
        }
        try:
            for chunk in stream:
                if cancellation and cancellation.cancelled:
                    text = "".join(parts).strip()
                    response = None
                    if text or final_usage:
                        input_tokens = int(final_usage.get("input_tokens") or prompt_tokens)
                        output_tokens = int(final_usage.get("output_tokens") or OpenAIModelRouter.estimate_tokens(text))
                        response = AIProviderResponse(
                            text=text, provider="sarvam", model=route.model, route=route.route,
                            reason=route.reason, language=route.language, intent=route.intent,
                            input_tokens=input_tokens, output_tokens=output_tokens, characters=len(text),
                            estimated_cost_amount=estimate_sarvam_chat_cost(route.model or "", input_tokens, output_tokens),
                            estimated_cost_currency="INR",
                            raw={"usage_actual": bool(final_usage), "cached_input_tokens": int(final_usage.get("cached_input_tokens") or 0), "cache_write_tokens": int(final_usage.get("cache_write_tokens") or 0), "cancelled": True, "provider_attempts": 1, "provider_calls_with_usage": 1 if final_usage else 0, "fallback_attempted": False, "finish_reason": "cancelled", "truncated": False, "completion_status": "cancelled"},
                        )
                    raise GenerationCancelled(response)
                final_usage = _extract_chat_usage(chunk) or final_usage
                choices = getattr(chunk, "choices", None) or (chunk.get("choices") if isinstance(chunk, dict) else []) or []
                choice = choices[0] if choices else None
                observed = _sarvam_finish_metadata(chunk)
                if observed["finish_reason"] != "unknown" or observed["completion_status"] != "unknown":
                    finish_metadata = observed
                delta_obj = choice.get("delta") if isinstance(choice, dict) else getattr(choice, "delta", None)
                delta = delta_obj.get("content") if isinstance(delta_obj, dict) else getattr(delta_obj, "content", None)
                if delta:
                    value = str(delta); parts.append(value); on_delta(value)
        except TypeError:
            # A stream that already emitted text must never be followed by a full
            # completion, which would duplicate the visible and billable answer.
            if parts:
                raise HTTPException(status_code=502, detail="Sarvam streaming ended unexpectedly.")
            if cancellation and cancellation.cancelled:
                raise GenerationCancelled()
            response = self.complete(request, route)
            on_delta(response.text)
            return response
        text = "".join(parts).strip()
        if not text:
            if max_attempts < 2:
                raise HTTPException(status_code=502, detail="Sarvam chat returned empty text.")
            response = self.complete(request, route)
            response.raw["provider_attempts"] = 2
            response.raw["fallback_attempted"] = True
            on_delta(response.text)
            return response
        input_tokens = int(final_usage.get("input_tokens") or prompt_tokens)
        output_tokens = int(final_usage.get("output_tokens") or OpenAIModelRouter.estimate_tokens(text))
        return AIProviderResponse(
            text=text, provider="sarvam", model=route.model, route=route.route, reason=route.reason,
            language=route.language, intent=route.intent, input_tokens=input_tokens, output_tokens=output_tokens,
            characters=len(text), estimated_cost_amount=estimate_sarvam_chat_cost(route.model or "", input_tokens, output_tokens),
            estimated_cost_currency="INR", raw={"usage_actual": bool(final_usage), "cached_input_tokens": int(final_usage.get("cached_input_tokens") or 0), "cache_write_tokens": int(final_usage.get("cache_write_tokens") or 0), "provider_attempts": 1, "provider_calls_with_usage": 1 if final_usage else 0, "fallback_attempted": False, **finish_metadata},
        )


    def _call_chat(self, client: Any, model: str, messages: list[dict[str, str]], max_tokens: int) -> Any:
        completions = getattr(getattr(client, "chat", None), "completions", None)
        if callable(completions):
            return completions(model=model, messages=messages, max_tokens=max_tokens, temperature=0.2)
        create = getattr(completions, "create", None)
        if callable(create):
            return create(model=model, messages=messages, max_tokens=max_tokens, temperature=0.2)
        raise HTTPException(status_code=503, detail="Sarvam chat client does not expose chat.completions.")

    def stt_file(
        self,
        file_path: str,
        language: Optional[str] = None,
        *,
        content_type: Optional[str] = None,
        filename: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> str:
        api_key = self._api_key()
        if not api_key:
            raise HTTPException(503, "SARVAM_API_KEY is not configured.")

        if not os.path.exists(file_path) or os.path.getsize(file_path) <= 0:
            raise HTTPException(400, "Audio file is empty. Please record for a moment and try again.")

        safe_filename = normalize_stt_upload_filename(file_path, filename)
        provider_content_type = normalize_stt_upload_mime_type(file_path, content_type)
        file_size = os.path.getsize(file_path)
        normalized_language = normalize_audio_language(language)
        self.last_stt_detected_language = None
        model = os.getenv("SARVAM_STT_MODEL", "saaras:v3").strip() or "saaras:v3"
        stt_mode = normalize_sarvam_stt_mode(
            mode or os.getenv("SARVAM_STT_MODE", "transcribe")
        )
        form_data: dict[str, str] = {"model": model, "mode": stt_mode}
        if normalized_language:
            form_data["language_code"] = normalized_language
        started = time.perf_counter()
        _log_sarvam_event(
            "sarvam_stt_upload_prepared",
            started=started,
            original_content_type=_clean_upload_mime_type(content_type),
            provider_content_type=provider_content_type,
            safe_filename=safe_filename,
            file_size=file_size,
        )

        try:
            with open(file_path, "rb") as audio_file:
                response = self._http_post(
                    SARVAM_STT_URL,
                    headers={"api-subscription-key": api_key},
                    files={"file": (safe_filename, audio_file, provider_content_type)},
                    data=form_data,
                    timeout=(5, 60),
                )
        except requests.Timeout as exc:
            _log_sarvam_event("sarvam_stt_failed", status_code=504, safe_provider_error="timeout", started=started)
            raise HTTPException(504, "STT provider timed out.") from exc
        except requests.RequestException as exc:
            detail = redact_sarvam_provider_message(str(exc), api_key) or "request failed."
            _log_sarvam_event("sarvam_stt_failed", status_code=502, safe_provider_error=detail, started=started)
            raise HTTPException(502, f"STT provider error: {detail}") from exc

        if response.status_code != 200:
            detail = sarvam_provider_error_detail(response, "STT provider", api_key)
            _log_sarvam_event("sarvam_stt_failed", status_code=response.status_code, safe_provider_error=detail, started=started)
            raise HTTPException(response.status_code, detail)

        try:
            payload = response.json()
        except ValueError as exc:
            _log_sarvam_event("sarvam_stt_failed", status_code=502, safe_provider_error="invalid_json", started=started)
            raise HTTPException(502, "STT provider returned invalid JSON.") from exc
        self.last_stt_detected_language = (
            extract_sarvam_detected_language(payload) or normalized_language
        )
        text = extract_sarvam_transcript(payload)
        if not text:
            _log_sarvam_event("sarvam_stt_failed", status_code=422, safe_provider_error="empty_transcript", started=started)
            raise HTTPException(422, SARVAM_STT_EMPTY_TRANSCRIPT_DETAIL)
        _log_sarvam_event(
            "sarvam_stt_completed",
            status_code=response.status_code,
            transcript_characters=len(text),
            started=started,
        )
        return text

    def tts(
        self,
        text: str,
        *,
        target_language_code: Optional[str] = None,
        speaker: Optional[str] = None,
        premium: bool = False,
    ) -> str:
        api_key = self._api_key()
        if not api_key:
            raise HTTPException(status_code=503, detail="SARVAM_API_KEY is not configured.")
        normalized_text = str(text or "").strip()
        if not normalized_text:
            raise HTTPException(status_code=400, detail="text is required.")

        model = normalize_sarvam_tts_model(
            os.getenv("SARVAM_TTS_MODEL_PREMIUM") if premium else os.getenv("SARVAM_TTS_MODEL"),
            premium=premium,
        )
        requested_speaker = speaker
        voice = resolve_sarvam_tts_voice(target_language_code or os.getenv("SARVAM_TTS_LANGUAGE", "ta-IN") or "ta-IN", requested_speaker)
        resolved_speaker = str(voice["speaker"])
        payload = {
            "text": normalized_text,
            "target_language_code": voice["target_language_code"],
            "speaker": resolved_speaker,
            "model": model,
        }
        if "pace" in voice:
            payload["pace"] = voice["pace"]
        started = time.perf_counter()
        requested_speaker_clean = str(requested_speaker or "").strip().lower()
        if requested_speaker_clean and requested_speaker_clean != resolved_speaker:
            _log_sarvam_event(
                "tts_speaker_fallback",
                started=started,
                model=model,
                requested_speaker=requested_speaker_clean,
                resolved_speaker=resolved_speaker,
                reason="incompatible_speaker",
            )
        _log_sarvam_event(
            "tts_started",
            started=started,
            model=model,
            tts_language_code=payload["target_language_code"],
            resolved_speaker=resolved_speaker,
            tts_locale_style=voice["style"],
        )

        def post_tts(request_payload: dict[str, Any], *, retry_label: str = "") -> Any:
            try:
                return self._http_post(
                    SARVAM_TTS_URL,
                    headers={"api-subscription-key": api_key},
                    json=request_payload,
                    timeout=(5, 30),
                )
            except requests.Timeout as exc:
                provider_error = f"{retry_label}_timeout" if retry_label else "timeout"
                detail = "TTS retry timed out." if retry_label else "TTS provider timed out."
                _log_sarvam_event("tts_failed", status_code=504, safe_provider_error=provider_error, started=started)
                raise HTTPException(status_code=504, detail=detail) from exc
            except requests.RequestException as exc:
                detail = redact_sarvam_provider_message(str(exc), api_key) or "request failed."
                _log_sarvam_event("tts_failed", status_code=502, safe_provider_error=detail, started=started)
                prefix = "TTS retry failed" if retry_label else "TTS provider error"
                raise HTTPException(status_code=502, detail=f"{prefix}: {detail}") from exc

        def speaker_fallback_from_error(error_text: str) -> Optional[str]:
            available = parse_sarvam_available_speakers(error_text)
            preferred_fallback = _language_fallback_speaker(str(voice["target_language_code"]))
            if preferred_fallback in available:
                return preferred_fallback
            if str(voice["target_language_code"]) == "ta-IN" and SARVAM_TTS_SPEAKER_EN_DEFAULT in available:
                return SARVAM_TTS_SPEAKER_EN_DEFAULT
            if SARVAM_TTS_DEFAULT_SPEAKER in available:
                return SARVAM_TTS_DEFAULT_SPEAKER
            if str(model or "").strip().lower() == SARVAM_TTS_DEFAULT_MODEL:
                for available_speaker in available:
                    if available_speaker in SARVAM_TTS_BULBUL_V2_SPEAKERS:
                        return available_speaker
                return preferred_fallback if preferred_fallback in SARVAM_TTS_BULBUL_V2_SPEAKERS else SARVAM_TTS_DEFAULT_SPEAKER
            return available[0] if available else None

        def maybe_retry_with_speaker_fallback(response: Any, request_payload: dict[str, Any], *, retry_label: str) -> tuple[Any, dict[str, Any], bool]:
            if response.status_code not in {400, 422}:
                return response, request_payload, False

            detail = sarvam_provider_error_detail(response, "TTS provider", api_key)
            if not is_sarvam_speaker_incompatible_error(detail):
                return response, request_payload, False

            fallback_speaker = speaker_fallback_from_error(detail)
            current_speaker = str(request_payload.get("speaker") or "").strip().lower()
            if not fallback_speaker or fallback_speaker == current_speaker:
                return response, request_payload, False

            retry_payload = {**request_payload, "speaker": fallback_speaker}
            _log_sarvam_event(
                "tts_speaker_fallback",
                started=started,
                model=model,
                requested_speaker=current_speaker,
                resolved_speaker=fallback_speaker,
                reason="incompatible_speaker",
            )
            return post_tts(retry_payload, retry_label=retry_label), retry_payload, True

        response = post_tts(payload)
        speaker_retry_used = False
        if response.status_code in {400, 422}:
            response, payload, speaker_retry_used = maybe_retry_with_speaker_fallback(
                response,
                payload,
                retry_label="speaker_retry",
            )

        if response.status_code in {400, 422}:
            legacy_payload = {**payload, "inputs": [normalized_text]}
            legacy_payload.pop("text", None)
            response = post_tts(legacy_payload, retry_label="legacy_retry")
            payload = legacy_payload
            if response.status_code in {400, 422} and not speaker_retry_used:
                response, payload, speaker_retry_used = maybe_retry_with_speaker_fallback(
                    response,
                    payload,
                    retry_label="speaker_retry",
                )

        if response.status_code == 200:
            try:
                data = response.json()
            except ValueError as exc:
                raise HTTPException(status_code=502, detail="TTS provider returned invalid JSON.") from exc
            if isinstance(data, dict) and isinstance(data.get("audios"), list) and data["audios"]:
                _log_sarvam_event(
                    "tts_completed",
                    audio_count=len(data["audios"]),
                    started=started,
                    model=model,
                    tts_language_code=payload.get("target_language_code"),
                    resolved_speaker=payload.get("speaker"),
                    tts_locale_style=voice["style"],
                )
                return str(data["audios"][0])
            raise HTTPException(status_code=502, detail="TTS provider response did not contain audio.")

        detail = sarvam_provider_error_detail(response, "TTS provider", api_key)
        _log_sarvam_event("tts_failed", status_code=response.status_code, safe_provider_error=detail, started=started)
        raise HTTPException(status_code=response.status_code, detail=detail)


def chat_model_for_intent(intent: str) -> str:
    if intent in {"coding", "complex_reasoning"}:
        return os.getenv("SARVAM_CHAT_MODEL_REASONING", "sarvam-105b").strip() or "sarvam-105b"
    return os.getenv("SARVAM_CHAT_MODEL", "sarvam-30b").strip() or "sarvam-30b"


def estimate_sarvam_chat_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    normalized = str(model or "").lower()
    if "105" in normalized:
        input_rate = _env_float("SARVAM_PRICE_105B_INPUT_INR_PER_1M", 4.0)
        output_rate = _env_float("SARVAM_PRICE_105B_OUTPUT_INR_PER_1M", 16.0)
    else:
        input_rate = _env_float("SARVAM_PRICE_30B_INPUT_INR_PER_1M", 2.5)
        output_rate = _env_float("SARVAM_PRICE_30B_OUTPUT_INR_PER_1M", 10.0)
    return (max(0, input_tokens) / 1_000_000.0) * input_rate + (max(0, output_tokens) / 1_000_000.0) * output_rate


def estimate_tts_cost(text: str, model: str) -> float:
    chars = len(str(text or ""))
    if "v3" in str(model or "").lower():
        rate = _env_float("SARVAM_PRICE_TTS_V3_INR_PER_10K_CHARS", 30.0)
    else:
        rate = _env_float("SARVAM_PRICE_TTS_V2_INR_PER_10K_CHARS", 15.0)
    return (chars / 10_000.0) * rate


def estimate_stt_cost(audio_seconds: float) -> float:
    rate = _env_float("SARVAM_PRICE_STT_INR_PER_HOUR", 30.0)
    return (max(0.0, float(audio_seconds or 0.0)) / 3600.0) * rate


def estimate_audio_duration_seconds(
    file_path: str,
    content_type: str = "",
    file_size: Optional[int] = None,
) -> float:
    seconds, _method = estimate_audio_duration_details(file_path, content_type, file_size)
    return seconds


def estimate_audio_duration_details(
    file_path: str,
    content_type: str = "",
    file_size: Optional[int] = None,
) -> tuple[float, str]:
    size = _safe_file_size(file_path, file_size)
    if size <= 0:
        return 0.0, "empty"

    ffprobe_seconds = _ffprobe_duration(file_path)
    if ffprobe_seconds and ffprobe_seconds > 0:
        return max(1.0, ffprobe_seconds), "ffprobe"

    suffix = Path(file_path).suffix.lower()
    mime = str(content_type or "").lower()
    if suffix == ".wav" or "wav" in mime:
        seconds = _wave_duration(file_path)
        if seconds and seconds > 0:
            return max(1.0, seconds), "wave"
    if suffix in {".aif", ".aiff", ".aifc"} or "aiff" in mime or "aifc" in mime:
        seconds = _aiff_duration(file_path)
        if seconds and seconds > 0:
            return max(1.0, seconds), "aifc"

    # Conservative compressed-audio fallback. 16 kbps tends to over-estimate
    # short voice-note duration, which protects free quota from undercounting.
    seconds = (size * 8.0) / 16_000.0
    return max(1.0, seconds), "file_size_16kbps_floor"


def _safe_file_size(file_path: str, file_size: Optional[int]) -> int:
    if file_size is not None:
        try:
            return max(0, int(file_size))
        except Exception:
            return 0
    try:
        return max(0, int(os.path.getsize(file_path)))
    except Exception:
        return 0


def _ffprobe_duration(file_path: str) -> Optional[float]:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            text=True,
            capture_output=True,
            timeout=3,
            check=False,
        )
        if result.returncode != 0:
            return None
        value = float(str(result.stdout or "").strip())
        return value if value > 0 else None
    except Exception:
        return None


def _wave_duration(file_path: str) -> Optional[float]:
    try:
        with wave.open(file_path, "rb") as audio:
            frames = audio.getnframes()
            rate = audio.getframerate()
            return frames / float(rate) if rate > 0 else None
    except Exception:
        return None


def _aiff_duration(file_path: str) -> Optional[float]:
    try:
        import aifc

        with aifc.open(file_path, "rb") as audio:
            frames = audio.getnframes()
            rate = audio.getframerate()
            return frames / float(rate) if rate > 0 else None
    except Exception:
        return None


def normalize_audio_language(language: Optional[str]) -> Optional[str]:
    value = str(language or "").strip().lower()
    if not value or value in {"auto", "detect", "auto-detect", "autodetect", "unknown"}:
        return None
    if value.startswith("ta"):
        return "ta-IN"
    if value.startswith("en"):
        return "en-IN"
    return None


def normalize_stt_upload_mime_type(file_path: str, content_type: Optional[str] = None) -> str:
    original = _clean_upload_mime_type(content_type)
    suffix = Path(file_path).suffix.lower()
    if original in SARVAM_STT_ACCEPTED_UPLOAD_MIME_TYPES and suffix != ".m4a":
        return original
    if suffix == ".m4a" or original in _MOBILE_AUDIO_UPLOAD_MIME_TYPES or original.startswith("audio/"):
        return "application/octet-stream"
    return "application/octet-stream"


def normalize_stt_upload_filename(file_path: str, filename: Optional[str] = None) -> str:
    fallback = Path(file_path).name or "audio.m4a"
    raw_name = Path(str(filename or fallback)).name
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", raw_name).strip("._-")
    if not safe_name:
        safe_name = fallback
    if "." not in safe_name:
        suffix = Path(file_path).suffix or ".m4a"
        safe_name = f"{safe_name}{suffix}"
    return safe_name


def _clean_upload_mime_type(content_type: Optional[str] = None) -> str:
    return str(content_type or "").split(";", 1)[0].strip().lower()


def redact_sarvam_provider_message(message: str, api_key: str = "") -> str:
    redacted = str(message or "")
    if api_key:
        redacted = redacted.replace(api_key, "[REDACTED]")
    redacted = re.sub(r"(?i)(api[-_ ]?subscription[-_ ]?key\s*[:=]\s*)[^\s,;]+", r"\1[REDACTED]", redacted)
    redacted = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", redacted)
    return redacted


def sarvam_provider_error_detail(response: Any, label: str, api_key: str = "") -> str:
    message = ""
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        error_payload = payload.get("error") if isinstance(payload.get("error"), dict) else payload
        message = str(error_payload.get("message") or error_payload.get("detail") or error_payload.get("error") or "").strip()
    if not message:
        message = str(getattr(response, "text", "") or "").strip()
    message = redact_sarvam_provider_message(message, api_key)
    if len(message) > 300:
        message = f"{message[:300]}..."
    return f"{label} returned {response.status_code}{f': {message}' if message else ''}"


def extract_sarvam_transcript(payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()
    if not isinstance(payload, dict):
        return ""
    for key in ("transcript", "text", "transcript_text", "output_text"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("results", "transcripts"):
        values = payload.get(key)
        if not isinstance(values, list):
            continue
        parts: list[str] = []
        for value in values:
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
            elif isinstance(value, dict):
                text = extract_sarvam_transcript(value)
                if text:
                    parts.append(text)
        if parts:
            return " ".join(parts).strip()
    return ""


def extract_sarvam_detected_language(payload: Any) -> Optional[str]:
    """Read provider detection metadata without changing the legacy STT return type."""
    if not isinstance(payload, dict):
        return None
    for key in ("language_code", "detected_language", "language"):
        normalized = normalize_audio_language(payload.get(key))
        if normalized:
            return normalized
    for key in ("result", "metadata"):
        nested = extract_sarvam_detected_language(payload.get(key))
        if nested:
            return nested
    for key in ("results", "transcripts"):
        values = payload.get(key)
        if isinstance(values, list):
            for value in values:
                nested = extract_sarvam_detected_language(value)
                if nested:
                    return nested
    return None


def _extract_chat_text(response: Any) -> str:
    if isinstance(response, dict):
        for key in ("content", "text", "output_text", "message"):
            value = response.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, dict):
                nested = _extract_chat_text(value)
                if nested:
                    return nested
        choices = response.get("choices")
        if isinstance(choices, list) and choices:
            return _extract_chat_text(choices[0])
    message = getattr(response, "message", None)
    if message is not None:
        content = getattr(message, "content", None)
        if isinstance(content, str):
            return content.strip()
    choices = getattr(response, "choices", None)
    if choices:
        return _extract_chat_text(choices[0])
    content = getattr(response, "content", None)
    return str(content or "").strip()


def _env_float(name: str, default: float) -> float:
    try:
        return max(0.0, float(str(os.getenv(name, default)).strip()))
    except Exception:
        return float(default)


def _log_sarvam_event(event: str, *, started: float, **fields: Any) -> None:
    logger.info(
        event,
        extra=chat_log_payload(
            event=event,
            duration_ms=round((time.perf_counter() - started) * 1000, 2),
            **fields,
        ),
    )
