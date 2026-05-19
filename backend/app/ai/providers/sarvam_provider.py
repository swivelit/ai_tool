from __future__ import annotations

import os
import re
import subprocess
import time
import wave
from pathlib import Path
from typing import Any, Callable, Optional

import requests
from fastapi import HTTPException

from ...observability import chat_log_payload
from ...openai_model_router import OpenAIModelRouter
from ..prompts import build_provider_messages
from ..types import AIProviderResponse, AIRequest, AIRoute
from .base import AIProvider


SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech"
SARVAM_STT_EMPTY_TRANSCRIPT_DETAIL = (
    "No speech was detected in the uploaded audio. Hold the mic until recording starts, then speak for at least a second."
)
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


class SarvamProvider(AIProvider):
    def __init__(
        self,
        client: Optional[Any] = None,
        *,
        client_factory: Optional[Callable[[], Any]] = None,
        http_post: Optional[Callable[..., Any]] = None,
        api_key_getter: Optional[Callable[[], str]] = None,
    ) -> None:
        self._client = client
        self._client_factory = client_factory
        self._http_post = http_post or requests.post
        self._api_key_getter = api_key_getter

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
        input_tokens = OpenAIModelRouter.estimate_tokens(request.message)
        output_tokens = OpenAIModelRouter.estimate_tokens(text)
        cost = estimate_sarvam_chat_cost(route.model or "", input_tokens, output_tokens)
        return AIProviderResponse(
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
            raw={"sdk_response_type": raw.__class__.__name__},
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
        model = os.getenv("SARVAM_STT_MODEL", "saaras:v3").strip() or "saaras:v3"
        mode = os.getenv("SARVAM_STT_MODE", "transcribe").strip() or "transcribe"
        form_data: dict[str, str] = {"model": model, "mode": mode}
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
        text = extract_sarvam_transcript(payload)
        if not text:
            _log_sarvam_event("sarvam_stt_failed", status_code=422, safe_provider_error="empty_transcript", started=started)
            raise HTTPException(422, SARVAM_STT_EMPTY_TRANSCRIPT_DETAIL)
        _log_sarvam_event("sarvam_stt_completed", status_code=response.status_code, transcript=text, started=started)
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

        model = (
            os.getenv("SARVAM_TTS_MODEL_PREMIUM", "bulbul:v3")
            if premium
            else os.getenv("SARVAM_TTS_MODEL", "bulbul:v2")
        ).strip() or ("bulbul:v3" if premium else "bulbul:v2")
        payload = {
            "text": normalized_text,
            "target_language_code": target_language_code or os.getenv("SARVAM_TTS_LANGUAGE", "ta-IN") or "ta-IN",
            "speaker": speaker or os.getenv("SARVAM_TTS_SPEAKER", "shubh") or "shubh",
            "model": model,
            "pace": 0.85,
        }
        started = time.perf_counter()
        try:
            response = self._http_post(
                SARVAM_TTS_URL,
                headers={"api-subscription-key": api_key},
                json=payload,
                timeout=(5, 30),
            )
        except requests.Timeout as exc:
            _log_sarvam_event("tts_failed", status_code=504, safe_provider_error="timeout", started=started)
            raise HTTPException(status_code=504, detail="TTS provider timed out.") from exc
        except requests.RequestException as exc:
            detail = redact_sarvam_provider_message(str(exc), api_key) or "request failed."
            _log_sarvam_event("tts_failed", status_code=502, safe_provider_error=detail, started=started)
            raise HTTPException(status_code=502, detail=f"TTS provider error: {detail}") from exc

        if response.status_code in {400, 422}:
            legacy_payload = {**payload, "inputs": [normalized_text]}
            legacy_payload.pop("text", None)
            try:
                response = self._http_post(
                    SARVAM_TTS_URL,
                    headers={"api-subscription-key": api_key},
                    json=legacy_payload,
                    timeout=(5, 30),
                )
            except requests.Timeout as exc:
                _log_sarvam_event("tts_failed", status_code=504, safe_provider_error="retry_timeout", started=started)
                raise HTTPException(status_code=504, detail="TTS retry timed out.") from exc
            except requests.RequestException as exc:
                detail = redact_sarvam_provider_message(str(exc), api_key) or "request failed."
                _log_sarvam_event("tts_failed", status_code=502, safe_provider_error=detail, started=started)
                raise HTTPException(status_code=502, detail=f"TTS retry failed: {detail}") from exc

        if response.status_code == 200:
            try:
                data = response.json()
            except ValueError as exc:
                raise HTTPException(status_code=502, detail="TTS provider returned invalid JSON.") from exc
            if isinstance(data, dict) and isinstance(data.get("audios"), list) and data["audios"]:
                _log_sarvam_event("tts_completed", audio_count=len(data["audios"]), started=started)
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
    import logging

    logging.getLogger(__name__).info(
        event,
        extra=chat_log_payload(
            event=event,
            duration_ms=round((time.perf_counter() - started) * 1000, 2),
            **fields,
        ),
    )
