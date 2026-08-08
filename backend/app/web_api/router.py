from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_CEILING
from uuid import UUID, uuid4
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, Response, StreamingResponse
from sqlalchemy import delete as sa_delete, or_, text, update as sa_update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlmodel import Session, select

from ..auth import (
    AuthUser,
    get_current_user,
    get_owned_user,
    is_internal_test_user,
    is_verified_admin_user,
)
from ..alembic_utils import repository_alembic_head
from ..billing.errors import (
    InsufficientCreditError, PaymentValidationError, RateLimitError,
    UsageLimitReachedError,
)
from ..billing.pricing import (
    calculate_topup, credit_percent, env_decimal, reserve_price, snapshot_json, stt_price, tts_price,
)
from ..billing.razorpay_client import RazorpayClient, verify_checkout_signature, verify_webhook_signature
from ..billing.schemas import CreateOrderRequest, TopupEstimateResponse, VerifyPaymentRequest
from ..billing.service import (
    create_billing_exempt_usage, create_usage_reservation, credit_payment_once,
    enforce_rate_limit, expand_usage_reservation, get_wallet_summary, get_wallet_summaries, list_wallet_ledger,
    release_billing_exempt_usage, release_usage_reservation, reverse_credit_for_refund,
    settle_billing_exempt_usage, settle_usage_reservation,
    release_swico_free_usage,
)
from ..billing.token_estimates import micros_for_blended_tokens, token_estimate
from ..billing.topups import (
    custom_topup_enabled, topup_bounds, topup_packages, validate_topup_amount,
)
from ..billing.usage_limits import validated_timezone
from ..ai.providers.base import (
    GenerationCancellation, GenerationCancelled, GenerationIncomplete,
    ProviderSafetyRejected,
    ProviderStreamInterrupted,
)
from ..ai.providers.swico_free_provider import SwicoFreeProviderError
from ..ai.budget import enforce_provider_budget
from ..ai.providers.sarvam_provider import (
    SarvamProvider, estimate_audio_duration_details,
    normalize_audio_language, normalize_sarvam_tts_model,
    normalize_sarvam_tts_language_code, normalize_stt_upload_mime_type,
    resolve_sarvam_tts_voice,
)
from ..ai.providers.sarvam_streaming_provider import (
    SarvamStreamingError, SarvamStreamingProvider, sarvam_tts_output_codec,
    sarvam_tts_sample_rate,
)
from ..ai.types import AIProviderResponse
from ..ai.usage import record_ai_usage_event
from ..audio_transcription import transcribe_audio_file
from ..ai.swico_tiers import (
    SWICO_TIER_IDS,
    SWICO_TIER_LABELS,
    SwicoTierConfigurationError,
    SwicoTierUnavailableError,
    default_swico_tier,
    configured_model_ladder,
    free_enabled,
    pro_enabled,
    public_tier_settings,
    tier_selection_enabled,
)
from .swico_free_access import swico_free_eligible
from ..database import SessionLocal, get_session
from ..models import (
    GlobalQACache, PaymentOrder, ProcessedWebhook, UsageCharge, WebChatMessage,
    WebChatThread, WalletLedger, WebConversationSummary, WebMemoryFact,
    WebMessageFeedback, WebUsagePreferences, WebCodeRepository,
    WebKnowledgeDocument,
)
from ..web_ai.code_quality.repository_archive import (
    ArchiveLimits, UnsafeRepositoryArchive,
)
from ..web_ai.code_quality.validation_client import (
    RepositoryValidationClient, ValidationClientSettings,
)
from ..web_ai.settings import TriagSettings
from ..web_ai.rollout import (
    RolloutConfigurationError,
    RolloutGlobalFlags,
    TriagReleaseConfigurationError,
    TriagReleaseState,
    WebRolloutDecision,
    WebRolloutPolicy,
    effective_triag_settings,
    resolve_rollout_decision,
)
from ..web_ai.rollout_metrics import (
    RolloutReportConfigurationError,
    RolloutReportSettings,
    build_rollout_report,
)
from ..web_ai.request_audit import build_request_audit
from ..web_ai.knowledge_jobs import enqueue_knowledge_job, cancel_knowledge_job
from ..web_ai.retrieval.attachment import safe_locator, upload_content_hash
from ..web_ai.retrieval.persistent_knowledge import (
    ApprovedKnowledgeChunk,
    approve_persistent_knowledge,
)
from ..observability import APP_RELEASE, get_request_id
from ..openai_tracked import OpenAIBudgetExceededError
from ..time_utils import utc_now
from .chat_service import (
    AttachmentRequestError, DuplicateRequestInProgress, EditRequestError,
    PromptBudgetExceeded, execute_web_turn, prepare_web_turn,
    record_web_turn_lifecycle, record_web_turn_pre_generation_abort,
)
from .continuation import (
    metadata_dict as continuation_metadata_dict,
    sanitize_render_prefix,
)
from .document_extraction import (
    DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, DocumentValidationError,
    chunk_virtual_text, extract_document, image_max_count,
    image_max_file_bytes, image_uploads_enabled, is_image_extension,
    max_file_bytes, sanitize_filename, validate_content_signature,
    validate_extension_and_mime,
)
from .schemas import (
    AssistantSettingsPatch, MemorySettingsPatch, ProfilePatch, ThreadCreate, ThreadPatch,
    KnowledgeApprovalRequest, KnowledgeDocumentListResponse,
    KnowledgeDocumentResultResponse, KnowledgeJobResultResponse,
    KnowledgeReindexRequest, MessageFeedbackRequest, UsagePreferencesPatch,
    VirtualTextUploadRequest,
    WebChatRequest, WebTTSRequest,
    TriagRequestAuditRequest,
)
from .usage_service import ai_credits, selected_swico_tier, usage_preferences_dict, usage_summary
from .upload_store import (
    EphemeralUpload, UploadStoreUnavailable, expiration_iso, get_upload_store,
    upload_ttl_seconds, utc_iso,
)
from .repository_service import (
    create_repository_snapshot, invalidate_repository_index,
)
from .repository_store import (
    get_repository_snapshot, repository_store_key,
)
from .knowledge_library import (
    delete_owned_knowledge_document,
    latest_owned_knowledge_job,
    list_owned_knowledge_documents,
    owned_knowledge_document,
    reindex_owned_knowledge_document,
    safe_document_summary,
    safe_job_summary,
)
from .voice_sessions import (
    VoiceSessionConflict, VoiceTicket, VoiceTicketStore,
)
from .realtime_voice import (
    VOICE_CLOSE_CODES, VoiceEndpointConfig, VoiceState, endpoint_delay_ms,
    join_final_segments, provider_error_code,
)
from .adaptive_endpointing import (
    EndpointEvidence, EndpointTiming, TranscriptClassification, VoiceProsodyTracker,
    append_final_segment, classify_transcript, decide_endpoint,
)

router = APIRouter(prefix="/api/web", tags=["web"])
logger = logging.getLogger(__name__)
_active_generations: dict[str, tuple[int, GenerationCancellation]] = {}
_pending_generation_cancellations: dict[str, int] = {}
_active_generations_lock = threading.Lock()
_voice_ticket_store: VoiceTicketStore | None = None
VOICE_PROTOCOL_VERSION = 1
ALEMBIC_HEAD = repository_alembic_head()


def _tickets() -> VoiceTicketStore:
    global _voice_ticket_store
    if _voice_ticket_store is None:
        _voice_ticket_store = VoiceTicketStore()
    return _voice_ticket_store


def reset_voice_ticket_store_for_tests() -> None:
    global _voice_ticket_store
    _voice_ticket_store = None


def _env_enabled(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _backend_release() -> str:
    for name in ("RENDER_GIT_COMMIT", "APP_RELEASE_SHA", "GIT_SHA", "SOURCE_VERSION"):
        value = os.getenv(name, "").strip()
        if value:
            return value[:12]
    release = str(APP_RELEASE or "").strip()
    return release[:12] if release and release != "dev" else "dev"


def _web_rollout(
    auth: AuthUser, user, *, settings: TriagSettings | None = None
) -> tuple[WebRolloutDecision, TriagSettings]:
    global_settings = settings or TriagSettings.from_environ()
    try:
        policy = WebRolloutPolicy.from_environ()
    except RolloutConfigurationError:
        # Production startup validation reports variable names. Requests fail
        # closed without logging values if an optional rollout is malformed.
        policy = WebRolloutPolicy.from_environ({})
    try:
        release_state = TriagReleaseState.from_environ()
    except TriagReleaseConfigurationError:
        # Startup exposes only the variable name. Requests retain the safe
        # controlled cache policy when configuration is malformed.
        release_state = TriagReleaseState.CONTROLLED
    decision = resolve_rollout_decision(
        policy,
        owner_user_id=int(user.id),
        internal_account=is_internal_test_user(auth, user),
        global_flags=RolloutGlobalFlags.from_settings(global_settings),
        release_state=release_state,
    )
    return decision, effective_triag_settings(global_settings, decision)


def _rollout_report_settings() -> RolloutReportSettings:
    try:
        return RolloutReportSettings.from_environ()
    except RolloutReportConfigurationError:
        # Startup and production validation expose variable names. The request
        # path fails closed without logging configuration values.
        return RolloutReportSettings()


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(maximum, max(minimum, value))


def _bounded_float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(maximum, max(minimum, value))


def _voice_tuning() -> dict[str, int | float]:
    threshold_min = _bounded_float_env("WEB_VOICE_GATE_THRESHOLD_MIN", 0.012, 0.005, 0.08)
    threshold_max = max(
        threshold_min,
        _bounded_float_env("WEB_VOICE_GATE_THRESHOLD_MAX", 0.065, 0.02, 0.12),
    )
    return {
        "calibration_ms": _bounded_int_env("WEB_VOICE_GATE_CALIBRATION_MS", 400, 300, 500),
        "noise_multiplier": _bounded_float_env("WEB_VOICE_GATE_NOISE_MULTIPLIER", 2.4, 1.25, 5.0),
        "threshold_min": threshold_min,
        "threshold_max": threshold_max,
        "quiet_fallback": min(
            threshold_min,
            _bounded_float_env("WEB_VOICE_GATE_QUIET_FALLBACK", 0.008, 0.006, 0.06),
        ),
        "no_speech_warning_ms": _bounded_int_env("WEB_VOICE_NO_SPEECH_WARNING_MS", 10_000, 3_000, 30_000),
    }


def _voice_playback_selection(
    browser_capabilities: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Select one provider codec before a paid turn begins.

    Browser input is capability-only. It can make `auto` choose the safe MP3
    path, but can never supply a codec, sample rate, price, or provider option.
    """
    requested_mode = os.getenv(
        "WEB_REALTIME_VOICE_PLAYBACK_MODE", "buffered_mp3"
    ).strip().lower()
    configured_codec = sarvam_tts_output_codec()
    sample_rate = sarvam_tts_sample_rate()
    capabilities = browser_capabilities if isinstance(browser_capabilities, dict) else {}
    allowed_keys = {"web_audio", "media_source", "media_source_mp3"}
    if len(capabilities) > len(allowed_keys) or any(
        key not in allowed_keys or not isinstance(value, bool)
        for key, value in capabilities.items()
    ):
        raise HTTPException(422, "Invalid browser capabilities")

    web_audio = capabilities.get("web_audio") is True
    media_source_allowed = bool(
        capabilities.get("media_source") is True
        and capabilities.get("media_source_mp3") is True
    )
    if requested_mode == "buffered_mp3":
        return {
            "playback_mode": "buffered_mp3", "output_codec": "mp3",
            "sample_rate": sample_rate, "media_source_allowed": False,
        }
    if requested_mode == "pcm_stream":
        return {
            "playback_mode": "pcm_stream", "output_codec": "linear16",
            "sample_rate": sample_rate, "media_source_allowed": False,
        }
    if requested_mode != "auto":
        raise HTTPException(503, "Voice playback configuration is invalid")
    if configured_codec == "linear16" and web_audio:
        return {
            "playback_mode": "pcm_stream", "output_codec": "linear16",
            "sample_rate": sample_rate, "media_source_allowed": False,
        }
    return {
        "playback_mode": "auto" if media_source_allowed else "buffered_mp3",
        "output_codec": "mp3", "sample_rate": sample_rate,
        "media_source_allowed": media_source_allowed,
    }


def _temporary_error(
    status_code: int, code: str, message: str, *, headers: dict[str, str] | None = None,
) -> JSONResponse:
    response_headers = {"Cache-Control": "no-store"}
    if headers:
        response_headers.update(headers)
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
        headers=response_headers,
    )


def _uploads_public_config() -> dict[str, Any]:
    enabled = _env_enabled("WEB_ATTACHMENTS_ENABLED")
    available = False
    if enabled:
        try:
            available = get_upload_store().available()
        except UploadStoreUnavailable:
            available = False
    try:
        configured_files = int(os.getenv("WEB_UPLOAD_MAX_FILES_PER_MESSAGE", "5"))
    except ValueError:
        configured_files = 5
    try:
        configured_total = int(os.getenv("WEB_UPLOAD_MAX_TOTAL_BYTES", str(25 * 1024 * 1024)))
    except ValueError:
        configured_total = 25 * 1024 * 1024
    return {
        "available": available,
        "ttl_seconds": upload_ttl_seconds(),
        "max_file_bytes": max_file_bytes(),
        "max_files_per_message": min(5, max(1, configured_files)),
        "max_total_bytes": min(25 * 1024 * 1024, max(1, configured_total)),
        "supported_extensions": list(
            DOCUMENT_EXTENSIONS
            + (IMAGE_EXTENSIONS if image_uploads_enabled() else ())
        ),
        "image_uploads_enabled": image_uploads_enabled(),
        "image_max_file_bytes": image_max_file_bytes(),
        "image_max_count": image_max_count(),
        "long_input_enabled": _env_enabled("WEB_LONG_INPUT_ENABLED"),
        "long_input_inline_threshold_chars": _bounded_int_env(
            "WEB_LONG_INPUT_INLINE_THRESHOLD_CHARS", 12_000, 1_000, 16_000
        ),
        "long_input_max_chars": _bounded_int_env(
            "WEB_LONG_INPUT_MAX_CHARS", 64_000, 16_000, 64_000
        ),
    }


def _rate_limit(session: Session, *, user_id: int, action: str, limit: int) -> None:
    try:
        enforce_rate_limit(session, user_id=user_id, action=action, limit=limit)
    except RateLimitError as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": "60"}) from exc


class SwicoFreeLimitError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _enforce_swico_free_limits(user_id: int) -> None:
    try:
        minute_limit = int(os.getenv("SWICO_FREE_RATE_LIMIT_PER_MINUTE", "2"))
        daily_limit = int(os.getenv("SWICO_FREE_DAILY_MESSAGE_LIMIT", "10"))
    except ValueError as exc:
        raise SwicoFreeLimitError(
            "swico_free_rate_limited", "Swico Free is temporarily rate limited."
        ) from exc
    with SessionLocal() as session:
        try:
            enforce_rate_limit(
                session, user_id=user_id, action="swico_free_generation_minute",
                limit=max(1, minute_limit), window_seconds=60,
            )
        except RateLimitError as exc:
            session.rollback()
            raise SwicoFreeLimitError(
                "swico_free_rate_limited",
                "Swico Free is temporarily rate limited. Please try again shortly.",
            ) from exc
        try:
            # Serialize the completed/pending usage check with the existing
            # rate-limit row. The row is only a lock; the daily allowance is
            # derived from zero-cost UsageCharge records below.
            enforce_rate_limit(
                session, user_id=user_id, action="swico_free_daily_usage_lock",
                limit=2_147_483_647, window_seconds=86_400,
            )
            now = utc_now()
            epoch = int(now.timestamp())
            day_start = datetime.fromtimestamp(
                epoch - (epoch % 86_400), tz=timezone.utc,
            )
            completed = len(session.exec(select(UsageCharge.id).where(
                UsageCharge.user_id == user_id,
                UsageCharge.swico_tier == "free",
                UsageCharge.usage_kind == "chat",
                UsageCharge.status == "free",
                UsageCharge.settled_at >= day_start,
            )).all())
            pending_cutoff = now - timedelta(minutes=5)
            pending = len(session.exec(select(UsageCharge.id).where(
                UsageCharge.user_id == user_id,
                UsageCharge.swico_tier == "free",
                UsageCharge.usage_kind == "chat",
                UsageCharge.status == "free_pending",
                UsageCharge.created_at >= pending_cutoff,
            )).all())
            daily_cap = max(1, daily_limit)
            if (completed >= daily_cap and pending == 0) or completed + pending > daily_cap:
                raise SwicoFreeLimitError(
                    "swico_free_daily_limit",
                    "Swico Free has reached its daily message limit. Please try again tomorrow.",
                )
            session.commit()
        except RateLimitError as exc:
            session.rollback()
            raise SwicoFreeLimitError(
                "swico_free_rate_limited",
                "Swico Free is temporarily rate limited. Please try again shortly.",
            ) from exc
        except SwicoFreeLimitError:
            session.rollback()
            raise


def _release_swico_free_request(request_id: str) -> None:
    with SessionLocal() as session:
        release_swico_free_usage(
            session, request_id, annotate_terminal=True,
        )
        session.commit()


def _pagination(limit: int, offset: int) -> tuple[int, int]:
    return min(max(1, limit), 100), max(0, offset)


def _checkout_enabled() -> bool:
    return os.getenv("BILLING_CHECKOUT_ENABLED", "false").strip().lower() in {
        "1", "true", "yes", "on",
    }


def _razorpay_mode() -> str:
    mode = os.getenv("RAZORPAY_MODE", "test").strip().lower()
    key_id = os.getenv("RAZORPAY_KEY_ID", "").strip()
    valid = mode in {"test", "live"} and (
        (mode == "test" and key_id.startswith("rzp_test_"))
        or (mode == "live" and key_id.startswith("rzp_live_"))
    )
    if not valid:
        raise HTTPException(503, {
            "code": "billing_configuration_invalid",
            "message": "Payment checkout configuration is unavailable.",
        })
    return mode


def _voice_credit_estimate(credited_micros: int) -> dict[str, Any]:
    credit_inr = Decimal(max(0, int(credited_micros))) / Decimal("1000000")
    markup = env_decimal("USAGE_MARKUP_MULTIPLIER", "1.0")
    stt_rate = env_decimal("SARVAM_PRICE_STT_INR_PER_HOUR", "30") * markup
    tts_model = normalize_sarvam_tts_model(os.getenv("SARVAM_TTS_MODEL"), premium=False)
    tts_rate = env_decimal(
        "SARVAM_PRICE_TTS_V3_INR_PER_10K_CHARS" if "v3" in tts_model.lower()
        else "SARVAM_PRICE_TTS_V2_INR_PER_10K_CHARS",
        "30" if "v3" in tts_model.lower() else "15",
    ) * markup
    stt_seconds = int(credit_inr * Decimal("3600") / stt_rate) if stt_rate > 0 else 0
    tts_characters = int(credit_inr * Decimal("10000") / tts_rate) if tts_rate > 0 else 0
    return {
        "pricing_version": os.getenv("SARVAM_PRICING_AS_OF", "configured-current"),
        "estimated_stt_seconds": stt_seconds,
        "estimated_stt_minutes": str((Decimal(stt_seconds) / Decimal("60")).quantize(Decimal("0.01"))),
        "estimated_tts_characters": tts_characters,
        "assumption": "STT-only or TTS-only at configured Sarvam rates; not guaranteed conversation time.",
    }


def public_billing_config(swico_tier: str = "lite") -> dict[str, Any]:
    mode = _razorpay_mode()
    minimum, maximum = topup_bounds()
    packages = []
    for gross in topup_packages():
        credit_micros, platform_paise = calculate_topup(gross)
        packages.append({
            "gross_amount_paise": gross,
            "credited_amount_micros": credit_micros,
            "platform_share_paise": platform_paise,
            "token_estimate": token_estimate(credit_micros, tier=swico_tier),
            "voice_estimate": _voice_credit_estimate(credit_micros),
        })
    return {
        "currency": "INR", "credit_percent": str(credit_percent()),
        "razorpay_mode": mode, "checkout_enabled": _checkout_enabled(),
        "razorpay_key_id": os.getenv("RAZORPAY_KEY_ID", "").strip(),
        "min_topup_paise": minimum, "max_topup_paise": maximum,
        "custom_topup_enabled": custom_topup_enabled(),
        "packages": packages,
    }


def _serialize_thread(row: WebChatThread) -> dict[str, Any]:
    return {
        "id": row.id, "title": row.title, "archived_at": row.archived_at,
        "created_at": row.created_at, "updated_at": row.updated_at,
    }


def _serialize_message(
    row: WebChatMessage, attachment_cache: dict[str, tuple[str, int | None]] | None = None,
) -> dict[str, Any]:
    tier = row.swico_tier if row.swico_tier in SWICO_TIER_IDS else None
    attachments: list[dict[str, Any]] = []
    try:
        metadata = json.loads(row.metadata_json or "{}")
    except (TypeError, ValueError):
        metadata = {}
    if not isinstance(metadata, dict):
        metadata = {}
    input_mode = metadata.get("input_mode")
    input_mode = input_mode if input_mode in {"text", "voice", "dictation", "realtime_voice"} else "text"
    if input_mode == "voice":
        input_mode = "dictation"
    voice_turn_id = metadata.get("voice_turn_id") if input_mode != "text" else None
    if input_mode == "text" and row.role == "assistant" and row.request_id:
        try:
            voice_turn_id = str(UUID(str(row.request_id)))
        except ValueError:
            voice_turn_id = None
    reply_language = metadata.get("reply_language")
    reply_language = reply_language if reply_language in {"en", "ta"} else None
    raw_attachments = metadata.get("attachments")
    status_cache = attachment_cache if attachment_cache is not None else {}
    for value in raw_attachments if isinstance(raw_attachments, list) else []:
        if not isinstance(value, dict):
            continue
        upload_id = str(value.get("id") or "")
        if not upload_id:
            continue
        cached = status_cache.get(upload_id)
        if cached is None:
            try:
                upload = get_upload_store().get(upload_id)
                if upload is None:
                    status = "expired"
                    owner_id = None
                else:
                    status = "ready" if upload.owner_user_id == int(row.user_id) else "unavailable"
                    owner_id = upload.owner_user_id
            except UploadStoreUnavailable:
                status, owner_id = "unavailable", None
            status_cache[upload_id] = (status, owner_id)
        else:
            status, owner_id = cached
        if owner_id is not None and owner_id != int(row.user_id):
            status = "unavailable"
        attachments.append({
            "id": upload_id,
            "name": sanitize_filename(str(value.get("name") or "document")),
            "media_type": str(value.get("media_type") or "application/octet-stream")[:160],
            "size_bytes": max(0, int(value.get("size_bytes") or 0)),
            "created_at": str(value.get("created_at") or ""),
            "expires_at": str(value.get("expires_at") or ""),
            "status": status,
            "warnings": [str(item)[:240] for item in value.get("warnings", [])[:5]]
            if isinstance(value.get("warnings"), list) else [],
            "warning_codes": [str(item)[:80] for item in value.get("warning_codes", [])[:5]]
            if isinstance(value.get("warning_codes"), list) else [],
        })
    try:
        continuation_segment_index = int(
            metadata.get("continuation_segment_index") or 0
        )
    except (TypeError, ValueError):
        continuation_segment_index = 0
    failure_code = (
        OpenAIBudgetExceededError.code
        if metadata.get("failure_code") == OpenAIBudgetExceededError.code
        else None
    )
    retry_at: str | None = None
    if failure_code:
        candidate_retry_at = str(metadata.get("retry_at") or "").strip()
        try:
            parsed_retry_at = datetime.fromisoformat(
                candidate_retry_at.replace("Z", "+00:00")
            )
            if parsed_retry_at.tzinfo is not None:
                retry_at = candidate_retry_at
        except ValueError:
            pass
    raw_sources = metadata.get("sources")
    sources = [
        {
            "id": str(source.get("id") or "")[:16],
            "label": sanitize_filename(
                str(source.get("label") or "Uploaded document")
            )[:128],
            "locator": str(source.get("locator") or "")[:256],
            "confidence": max(
                0.0, min(1.0, float(source.get("confidence") or 0.0))
            ),
            "source_kind": str(source.get("source_kind") or "")[:32],
        }
        for source in (
            raw_sources if isinstance(raw_sources, list) else []
        )
        if isinstance(source, dict)
    ]
    raw_quality = metadata.get("quality")
    quality = None
    if isinstance(raw_quality, dict):
        quality_status = str(raw_quality.get("status") or "")
        if quality_status in {
            "verified", "grounded", "best_effort", "unverified",
            "insufficient_evidence",
        }:
            quality_checks = []
            for check in (
                raw_quality.get("checks")
                if isinstance(raw_quality.get("checks"), list) else []
            ):
                if not isinstance(check, dict):
                    continue
                check_type = str(check.get("type") or "")[:64]
                check_status = str(check.get("status") or "")
                if check_type and check_status in {
                    "passed", "failed", "warning", "skipped", "error",
                }:
                    quality_checks.append({
                        "type": check_type, "status": check_status,
                    })
            quality = {
                "status": quality_status,
                "retrieval_status": (
                    str(raw_quality.get("retrieval_status") or "") or None
                ),
                "checks": quality_checks[:24],
                "repository_validation_mode": (
                    str(raw_quality.get("repository_validation_mode"))
                    if raw_quality.get("repository_validation_mode") in {
                        "static_only", "executable", "unavailable",
                    }
                    else None
                ),
                "repair_attempted": raw_quality.get("repair_attempted") is True,
            }
    return {
        "id": row.id, "thread_id": row.thread_id, "role": row.role, "content": row.content,
        "request_id": row.request_id, "tier": tier,
        "tier_label": SWICO_TIER_LABELS[tier] if tier else "Swico",
        "input_tokens": row.input_tokens, "output_tokens": row.output_tokens,
        "usage_source": row.usage_source, "charge_micros": row.charge_micros,
        "status": row.status, "created_at": row.created_at, "attachments": attachments,
        "input_mode": input_mode, "voice_turn_id": voice_turn_id,
        "reply_language": reply_language,
        "finish_reason": str(metadata.get("finish_reason") or "unknown"),
        "truncated": bool(metadata.get("truncated")),
        "completion_status": str(metadata.get("completion_status") or "unknown"),
        "can_continue": (
            bool(metadata.get("truncated"))
            and row.role == "assistant"
            and row.status == "complete"
            and not bool(metadata.get("continuation_consumed"))
            and not metadata.get("continued_by_message_id")
        ),
        "is_continuation_control": bool(
            metadata.get("is_continuation_control")
        ),
        "continuation_render_prefix": sanitize_render_prefix(
            metadata.get("continuation_render_prefix")
        ),
        "continuation_parent_message_id": (
            str(metadata.get("continuation_parent_message_id"))
            if metadata.get("continuation_parent_message_id") else None
        ),
        "continuation_root_message_id": (
            str(metadata.get("continuation_root_message_id"))
            if metadata.get("continuation_root_message_id") else None
        ),
        "continuation_segment_index": continuation_segment_index,
        "continuation_rewind_characters": max(
            0, min(14_000, int(metadata.get("continuation_rewind_characters") or 0))
        ),
        "failure_code": failure_code,
        "retry_at": retry_at,
        "replaces_message_id": row.replaces_message_id,
        "revision_number": row.revision_number,
        "feedback_rating": (
            str(metadata.get("feedback_rating"))
            if metadata.get("feedback_rating") in {"up", "down"} else None
        ),
        "provenance": (
            [
                str(value)
                for value in metadata.get("provenance", [])
                if value in {
                    "memory", "document", "cached_answer", "semantic_cache",
                    "backend_tool", "web_search",
                }
            ]
            if _env_enabled("WEB_RESPONSE_PROVENANCE_ENABLED")
            and isinstance(metadata.get("provenance"), list)
            else []
        ),
        "sources": sources,
        "quality": quality,
    }


def _resolved_reply_language(user) -> str:
    value = str(user.reply_language or "").strip().lower()
    if value not in {"en", "ta"}:
        raise HTTPException(422, {
            "code": "invalid_profile_language",
            "message": "Saved reply language must be English or Tamil.",
        })
    return value


def _owned_thread(session: Session, user_id: int, thread_id: str) -> WebChatThread:
    row = session.exec(select(WebChatThread).where(
        WebChatThread.id == thread_id, WebChatThread.user_id == user_id
    )).first()
    if row is None:
        raise HTTPException(404, "Thread not found")
    return row


@router.get("/health")
def web_health(session: Session = Depends(get_session)):
    session.exec(text("SELECT 1"))
    return {"ok": True, "api": "web", "database": "reachable"}


@router.get("/billing/public-config")
def billing_public_config():
    return public_billing_config(default_swico_tier())


@router.get("/bootstrap")
def bootstrap(
    response: Response, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    user = get_owned_user(session, auth)
    billing_exempt = is_internal_test_user(auth, user)
    free_available = swico_free_eligible(
        int(user.id), internal_account=billing_exempt,
    )
    swico_tier = selected_swico_tier(session, int(user.id))
    if swico_tier == "free" and not free_available:
        swico_tier = "lite"
    uploads = _uploads_public_config()
    rollout, triag_settings = _web_rollout(auth, user)
    validation_capability = "static_only"
    if triag_settings.code_validation_runtime_enabled:
        validation_capability = RepositoryValidationClient(
            ValidationClientSettings(
                base_url=triag_settings.code_validator_url,
                auth_token=triag_settings.code_validator_auth_token,
                timeout_seconds=triag_settings.code_validator_timeout_seconds,
            )
        ).validation_capability_sync()
    return {
        "user": {"id": user.id, "name": user.name, "email": user.email, "reply_language": user.reply_language},
        # `wallet` is the legacy Chat wallet and remains for mobile/web
        # compatibility. New clients should use `wallets`.
        "wallet": get_wallet_summary(session, int(user.id), swico_tier=swico_tier,
                                     billing_exempt=billing_exempt, credit_bucket="chat"),
        "wallets": get_wallet_summaries(session, int(user.id), swico_tier=swico_tier,
                                         billing_exempt=billing_exempt),
        "billing": public_billing_config(swico_tier),
        "assistant": public_tier_settings(swico_tier, free_available=free_available),
        "features": {
            "web_chat": True,
            "prepaid_billing": True,
            "web_attachments": _env_enabled("WEB_ATTACHMENTS_ENABLED") and bool(uploads["available"]),
            "web_image_uploads": bool(
                uploads["available"] and uploads["image_uploads_enabled"]
            ),
            "web_voice_recording": _env_enabled("WEB_VOICE_RECORDING_ENABLED"),
            "web_voice_reply": _env_enabled("WEB_VOICE_REPLY_ENABLED"),
            "web_voice_billing": _env_enabled("WEB_VOICE_BILLING_ENABLED"),
            "web_realtime_voice": _env_enabled("WEB_REALTIME_VOICE_ENABLED"),
            "separate_voice_credits": _env_enabled("WEB_SEPARATE_VOICE_CREDITS_ENABLED"),
            "web_message_edit": _env_enabled("WEB_MESSAGE_EDIT_ENABLED"),
            "web_cross_thread_memory": _env_enabled("WEB_CROSS_THREAD_MEMORY_ENABLED"),
            "web_long_input": _env_enabled("WEB_LONG_INPUT_ENABLED"),
            "web_answer_feedback": _env_enabled("WEB_ANSWER_FEEDBACK_ENABLED"),
            "web_content_search": _env_enabled("WEB_CONTENT_SEARCH_ENABLED"),
            "web_response_provenance": _env_enabled("WEB_RESPONSE_PROVENANCE_ENABLED"),
            "web_repository_upload": triag_settings.repository_upload_enabled,
            "web_repository_chat": triag_settings.repository_chat_runtime_enabled,
            "web_repository_validation": (
                triag_settings.code_validation_runtime_enabled
            ),
            "web_knowledge_library": (
                rollout.knowledge_library.enabled
            ),
            "web_triag_hybrid": rollout.triag_hybrid.enabled,
            "web_answer_guard": rollout.answer_guard.enabled,
        },
        "backend_release": _backend_release(),
        "voice_protocol_version": VOICE_PROTOCOL_VERSION,
        "voice_tuning": _voice_tuning(),
        "uploads": uploads,
        "repositories": {
            "ttl_seconds": triag_settings.repository_ttl_seconds,
            "max_archive_bytes": triag_settings.repository_max_archive_bytes,
            "validation_capability": validation_capability,
        },
    }


@router.get("/admin/triag-rollout-report")
def triag_rollout_report(
    response: Response,
    window_hours: int | None = Query(default=None, ge=1),
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    user = get_owned_user(session, auth)
    settings = _rollout_report_settings()
    if not settings.enabled or not is_verified_admin_user(auth, user):
        raise HTTPException(status_code=404, detail="Not found")
    resolved_window = (
        settings.default_window_hours
        if window_hours is None else int(window_hours)
    )
    if resolved_window > settings.max_window_hours:
        raise HTTPException(
            status_code=422,
            detail="window_hours exceeds the configured reporting bound",
        )
    return build_rollout_report(
        session,
        window_hours=resolved_window,
        settings=settings,
    )


@router.post("/admin/triag-request-audit")
def triag_request_audit(
    payload: TriagRequestAuditRequest,
    response: Response,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    user = get_owned_user(session, auth)
    if not is_verified_admin_user(auth, user):
        raise HTTPException(status_code=404, detail="Not found")
    results = build_request_audit(
        session,
        request_ids=[str(request_id) for request_id in payload.request_ids],
    )
    if results is None:
        raise HTTPException(status_code=404, detail="Not found")
    return {"results": results}


@router.get("/voice/diagnostics")
def voice_diagnostics(
    request: Request, response: Response, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    user = get_owned_user(session, auth)
    if not is_internal_test_user(auth, user):
        return _temporary_error(404, "not_found", "Not found.")
    tier = selected_swico_tier(session, int(user.id))
    wallets = get_wallet_summaries(
        session, int(user.id), swico_tier=tier, billing_exempt=True,
    )
    voice_required = stt_price(5_000).micros + _voice_llm_preflight_micros(tier)
    store = _tickets()
    session_status = getattr(store, "session_status", None)
    active_session, remaining_lock_ttl_seconds = (
        session_status(int(user.id)) if callable(session_status) else (False, 0)
    )
    configured_origins = sorted({
        value.strip() for value in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if value.strip()
    })
    origin = request.headers.get("origin")
    return {
        "ok": True,
        "protocol_version": VOICE_PROTOCOL_VERSION,
        "backend_release": _backend_release(),
        "alembic_head": ALEMBIC_HEAD,
        "selected_tier_id": tier,
        "selected_language_code": _resolved_reply_language(user),
        "features": {
            "web_realtime_voice": _env_enabled("WEB_REALTIME_VOICE_ENABLED"),
            "separate_voice_credits": _env_enabled("WEB_SEPARATE_VOICE_CREDITS_ENABLED"),
            "web_voice_billing": _env_enabled("WEB_VOICE_BILLING_ENABLED"),
        },
        "authentication": {
            "internal_test_user": True,
            "email_verified": bool(auth.email_verified),
            "owned_email_matches": bool(
                auth.email and str(auth.email).strip().casefold() == str(user.email or "").strip().casefold()
            ),
        },
        "wallet_preflight": {
            "chat": {
                "billing_exempt": True,
                "available_micros": max(0, int(wallets["chat"]["available_micros"])),
                "required_micros": 0,
                "ready": True,
                "non_exempt_required_micros": 0,
                "required_for_realtime_voice": False,
            },
            "voice": {
                "billing_exempt": True,
                "available_micros": max(0, int(wallets["voice"]["available_micros"])),
                "required_micros": 0,
                "ready": True,
                "non_exempt_required_micros": voice_required,
                "required_for_realtime_voice": True,
            },
        },
        "valkey": {"configured": store.configured, "reachable": store.reachable()},
        "session_lock": {
            "active_session": active_session,
            "remaining_lock_ttl_seconds": remaining_lock_ttl_seconds,
        },
        "sarvam": {
            "configured": bool(os.getenv("SARVAM_API_KEY", "").strip()),
            "stt_model": os.getenv("SARVAM_STT_MODEL", "saaras:v3") or "saaras:v3",
            "tts_model": normalize_sarvam_tts_model(os.getenv("SARVAM_TTS_MODEL"), premium=False),
            "playback_mode": os.getenv(
                "WEB_REALTIME_VOICE_PLAYBACK_MODE", "buffered_mp3"
            ).strip().lower(),
            "selected_codec": sarvam_tts_output_codec(),
            "provider_sample_rate": sarvam_tts_sample_rate(),
        },
        "origin": {
            "configured_origins": configured_origins,
            "request_origin_allowed": bool(origin and origin in configured_origins),
        },
        "websocket": {
            "expected_scheme": "wss" if request.url.scheme == "https" or str(origin or "").startswith("https://") else "ws",
            "expected_path": "/api/web/voice/ws",
        },
    }


@router.post("/voice/sessions", status_code=201)
def create_voice_session(
    request: Request, response: Response,
    payload: dict[str, Any] | None = Body(default=None),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    started = time.monotonic()
    response.headers["Cache-Control"] = "no-store"
    user = get_owned_user(session, auth)
    tier = selected_swico_tier(session, int(user.id))
    language = _resolved_reply_language(user)
    billing_exempt = is_internal_test_user(auth, user)
    body = payload if isinstance(payload, dict) else {}
    if len(body) > 1 or any(key != "browser_capabilities" for key in body):
        raise HTTPException(422, "Invalid voice session metadata")
    playback = _voice_playback_selection(body.get("browser_capabilities"))
    if tier == "free":
        return _temporary_error(
            422, "swico_free_text_only",
            "Swico Free supports text only. Switch to Swico Lite, Swico, or Swico Pro for voice.",
        )

    def outcome(status: int, code: str) -> None:
        logger.info("voice_session_creation", extra={
            "request_id": get_request_id(), "backend_release": _backend_release(),
            "selected_tier_id": tier, "selected_language_code": language,
            "billing_exempt": billing_exempt, "http_status": status,
            "outcome_code": code, "safe_duration_ms": int((time.monotonic() - started) * 1000),
        })

    if not _env_enabled("WEB_REALTIME_VOICE_ENABLED"):
        outcome(503, "feature_disabled")
        return _temporary_error(503, "realtime_voice_disabled", "Real-time Voice Mode is unavailable.")
    if not _env_enabled("WEB_SEPARATE_VOICE_CREDITS_ENABLED"):
        outcome(503, "wallet_feature_disabled")
        return _temporary_error(503, "voice_wallets_disabled", "Separate Voice credits are unavailable.")
    try:
        _rate_limit(
            session, user_id=int(user.id), action="voice_session_start",
            limit=int(os.getenv("WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE", "5")),
        )
    except HTTPException as exc:
        if exc.status_code != 429:
            raise
        session.rollback()
        outcome(429, "rate_limited")
        return JSONResponse(status_code=429, content={"error": {
            "code": "voice_rate_limit",
            "message": "Too many Voice Mode starts. Please wait a moment.",
        }}, headers={"Cache-Control": "no-store", "Retry-After": "60"})
    wallets = get_wallet_summaries(
        session, int(user.id), swico_tier=tier, billing_exempt=billing_exempt,
    )
    if not billing_exempt:
        voice_required = stt_price(5_000).micros + _voice_llm_preflight_micros(tier)
        voice_available = max(0, int(wallets["voice"]["available_micros"]))
        if voice_available < voice_required:
            session.rollback()
            outcome(402, "insufficient_voice_credit")
            return JSONResponse(status_code=402, content={"error": {
                "code": "insufficient_voice_credit",
                "credit_bucket": "voice",
                "required_micros": voice_required,
                "available_micros": voice_available,
                "message": "Add Voice credits to start Voice Mode.",
            }}, headers={"Cache-Control": "no-store"})
    session.commit()
    ttl = int(os.getenv("WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS", "60"))
    max_session = int(os.getenv("WEB_REALTIME_VOICE_MAX_SESSION_SECONDS", "900"))
    session_id = str(uuid4())
    expires_epoch = int(time.time()) + ttl
    metadata = VoiceTicket(
        session_id=session_id, user_id=int(user.id), tier=tier, language=language,
        billing_exempt=billing_exempt, expires_at_epoch=expires_epoch,
        playback_mode=playback["playback_mode"], output_codec=playback["output_codec"],
        sample_rate=playback["sample_rate"],
        media_source_allowed=playback["media_source_allowed"],
    )
    try:
        ticket = _tickets().mint(metadata, ttl, max_session)
    except VoiceSessionConflict:
        _, retry_after_seconds = _tickets().session_status(int(user.id))
        outcome(409, "session_conflict")
        return JSONResponse(status_code=409, content={"error": {
            "code": "voice_session_active",
            "message": "Another Voice Mode session may already be active. End it before trying again.",
            "retry_after_seconds": retry_after_seconds,
        }}, headers={"Cache-Control": "no-store", "Retry-After": str(retry_after_seconds)})
    except Exception:
        outcome(503, "valkey_unavailable")
        return _temporary_error(
            503, "voice_ticket_store_unavailable", "Voice Mode is temporarily unavailable."
        )
    base = str(request.base_url).rstrip("/")
    websocket_url = ("wss://" + base[8:] if base.startswith("https://")
                     else "ws://" + base[7:] if base.startswith("http://") else base)
    outcome(201, "ticket_created")
    return {
        "protocol_version": VOICE_PROTOCOL_VERSION,
        "session_id": session_id,
        "ticket": ticket,
        "websocket_url": f"{websocket_url}/api/web/voice/ws",
        "expires_at_epoch": expires_epoch,
        "tier": tier,
        "tier_label": SWICO_TIER_LABELS[tier],
        "language": language,
        "playback_mode": playback["playback_mode"],
        "selected_codec": playback["output_codec"],
        "provider_sample_rate": playback["sample_rate"] if playback["output_codec"] == "linear16" else None,
        "media_source_allowed": playback["media_source_allowed"],
        "wallet": wallets["chat"],
        "wallets": wallets,
    }


@router.delete("/voice/sessions", status_code=204)
def release_voice_session(
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    _rate_limit(
        session, user_id=int(user.id), action="voice_session_release", limit=10,
    )
    released = _tickets().force_release_user(int(user.id))
    logger.info("voice_session_release", extra={
        "request_id": get_request_id(), "backend_release": _backend_release(),
        "released": released,
    })
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


def _allowed_websocket_origin(origin: str | None) -> bool:
    configured = {
        value.strip() for value in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if value.strip()
    }
    return bool(origin and origin in configured)


async def _voice_send(websocket: WebSocket, message_type: str, **data: Any) -> None:
    await websocket.send_json({"protocol_version": 1, "type": message_type, **data})


def _voice_audio_start(metadata: VoiceTicket, turn_number: int) -> dict[str, Any]:
    linear16 = metadata.output_codec == "linear16"
    return {
        "content_type": "audio/L16" if linear16 else "audio/mpeg",
        "codec": metadata.output_codec,
        "sample_rate": metadata.sample_rate if linear16 else None,
        "channels": 1,
        "sample_format": "pcm_s16le" if linear16 else None,
        "playback_mode": metadata.playback_mode,
        "turn_number": int(turn_number),
    }


def _voice_audio_end(
    metadata: VoiceTicket, turn_number: int, *, chunks_sent: int,
    bytes_sent: int, characters: int, interrupted: bool,
) -> dict[str, Any]:
    return {
        "turn_number": int(turn_number), "codec": metadata.output_codec,
        "chunks_sent": max(0, int(chunks_sent)), "bytes_sent": max(0, int(bytes_sent)),
        "characters": max(0, int(characters)), "interrupted": bool(interrupted),
    }


def _voice_tts_chunks(buffer: str, *, final: bool = False) -> tuple[list[str], str]:
    """Return bounded, speakable chunks without waiting for the full answer."""
    chunks: list[str] = []

    def append_bounded(value: str) -> None:
        remaining = value.strip()
        while len(remaining) > 240:
            boundary = remaining.rfind(" ", 0, 241)
            boundary = boundary if boundary > 0 else 240
            chunks.append(remaining[:boundary].strip())
            remaining = remaining[boundary:].strip()
        if remaining:
            chunks.append(remaining)

    while buffer:
        sentence = re.search(r"[.!?।](?:\s+|$)", buffer)
        if sentence:
            append_bounded(buffer[:sentence.end()])
            buffer = buffer[sentence.end():].lstrip()
            continue
        # Do not hold an unusually long unpunctuated answer indefinitely.
        if len(buffer) > 480:
            boundary = buffer.rfind(" ", 0, 241)
            boundary = boundary if boundary > 0 else 240
            append_bounded(buffer[:boundary])
            buffer = buffer[boundary:].lstrip()
            continue
        break
    if final and buffer.strip():
        append_bounded(buffer)
        buffer = ""
    return chunks, buffer


def _voice_latency_payload(values: dict[str, float | int]) -> dict[str, int | None]:
    speech = float(values.get("speech_started_at") or 0)
    final = float(values.get("final_transcript_at") or 0)

    def elapsed(end_key: str, start: float) -> int | None:
        end = float(values.get(end_key) or 0)
        if end <= 0 or start <= 0 or end < start:
            return None
        return int((end - start) * 1000)

    return {
        "time_to_first_stt_partial_ms": elapsed("first_partial_at", speech),
        "time_to_final_transcript_ms": elapsed("final_transcript_at", speech),
        "time_to_first_model_delta_ms": elapsed("first_model_delta_at", final),
        "time_to_first_tts_audio_ms": elapsed("first_tts_audio_at", final),
        "barge_in_stop_latency_ms": (
            int(values["barge_in_stop_latency_ms"])
            if "barge_in_stop_latency_ms" in values else None
        ),
    }


def _voice_backchannel_due(
    *, enabled: bool, state: VoiceState, utterance_started_at: float | None,
    last_backchannel_at: float, now: float,
    classification: TranscriptClassification,
) -> bool:
    """Pure local gate; the backchannel path cannot invoke text generation."""
    return bool(
        enabled
        and state == VoiceState.LISTENING
        and utterance_started_at is not None
        and now - utterance_started_at >= 2.5
        and now - last_backchannel_at >= 8.0
        and classification is TranscriptClassification.UNFINISHED
    )


def _voice_llm_preflight_micros(tier: str) -> int:
    """Smallest non-zero reserve needed to begin the selected tier.

    The real chat reservation remains authoritative once a transcript exists.
    """
    model = configured_model_ladder(tier)[0]
    return max(1, reserve_price("openai", model, 1, 1).micros)


class _VoiceTargetedStop(RuntimeError):
    pass


@router.websocket("/voice/ws")
async def realtime_voice_socket(websocket: WebSocket, ticket: str = Query(..., min_length=20, max_length=160)):
    # The query ticket is intentionally never included in diagnostics.
    if not _allowed_websocket_origin(websocket.headers.get("origin")):
        await websocket.close(
            code=VOICE_CLOSE_CODES["voice_origin_rejected"], reason="voice_origin_rejected"
        )
        return
    metadata = await asyncio.to_thread(_tickets().consume, ticket)
    if metadata is None:
        await websocket.close(
            code=VOICE_CLOSE_CODES["voice_session_expired"], reason="voice_session_expired"
        )
        return

    await websocket.accept()
    provider = SarvamStreamingProvider()
    endpoint = VoiceEndpointConfig.from_env()
    idle_timeout = int(os.getenv("WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS", "60"))
    max_session = int(os.getenv("WEB_REALTIME_VOICE_MAX_SESSION_SECONDS", "900"))
    started_at = time.monotonic()
    state = VoiceState.CONNECTING
    stage = "ticket_consumed"
    turn_number = 1
    current_thread_id: str | None = None
    current_stt_request: str | None = None
    received_audio_bytes = 0
    audio_message_count = 0
    stt_reserved_milliseconds = 0
    stt_reserved_micros = 0
    last_audio_sequence = 0
    final_segments: list[str] = []
    last_partial = ""
    provider_audio_milliseconds = 0
    utterance_started_at: float | None = None
    speech_ended_at: float | None = None
    transcript_updated_at: float | None = None
    deadline_generation = 0
    endpoint_cancel_count = 0
    endpoint_delay = 0
    endpoint_reason = "no_clear_transcript"
    endpoint_classification = "neutral"
    prosody = VoiceProsodyTracker()
    endpoint_task: asyncio.Task[Any] | None = None
    stt_task: asyncio.Task[Any] | None = None
    process_task: asyncio.Task[Any] | None = None
    process_tasks: set[asyncio.Task[Any]] = set()
    tts_task: asyncio.Task[Any] | None = None
    generation_cancellation: GenerationCancellation | None = None
    structured_error_sent = False
    cleanup_succeeded = False
    reservations_released = False
    client_closed = False
    stop_event = asyncio.Event()
    process_lock = asyncio.Lock()
    voice_latency_by_turn: dict[int, dict[str, float | int]] = {}
    last_barge_in_stop_latency_ms: int | None = None
    last_backchannel_at = 0.0

    def diagnostic(exc: BaseException | None = None, *, cleanup: bool | None = None) -> None:
        logger.info(
            "realtime_voice_diagnostic",
            extra={
                "stage": stage,
                "exception_class": type(exc).__name__ if exc else None,
                "provider_close_code": (
                    exc.websocket_close_code if isinstance(exc, SarvamStreamingError) else None
                ),
                "provider_handshake_status": (
                    exc.handshake_status if isinstance(exc, SarvamStreamingError) else None
                ),
                "provider_category": (
                    exc.category if isinstance(exc, SarvamStreamingError) else None
                ),
                "provider_safe_code": (
                    exc.safe_code if isinstance(exc, SarvamStreamingError) else None
                ),
                "provider_retryable": (
                    exc.retryable if isinstance(exc, SarvamStreamingError) else None
                ),
                "audio_frame_samples": 512,
                "audio_message_count": audio_message_count,
                "session_duration_ms": int((time.monotonic() - started_at) * 1000),
                "turn_number": turn_number,
                "cleanup_succeeded": cleanup,
                "reservations_released": reservations_released,
                "barge_in_stop_latency_ms": last_barge_in_stop_latency_ms,
            },
        )

    async def set_state(next_state: VoiceState) -> None:
        nonlocal state
        state = next_state
        await _voice_send(websocket, "state.changed", state=next_state.value, turn_number=turn_number)

    async def endpoint_metadata() -> None:
        """Expose scalar endpoint evidence to internal test accounts only."""
        if not metadata.billing_exempt or not endpoint.adaptive_enabled:
            return
        summary = prosody.summary()
        await _voice_send(
            websocket, "endpoint.metadata",
            transcript_classification=endpoint_classification,
            terminal_cadence_detected=summary.terminal_cadence,
            trailing_off_detected=summary.trailing_off,
            voiced_duration_ms=summary.voiced_duration_ms,
            endpoint_delay_ms=endpoint_delay,
            endpoint_reason=endpoint_reason,
            endpoint_deadline_generation=deadline_generation,
            endpoint_cancel_count=endpoint_cancel_count,
        )

    async def targeted_error(
        code: str, message: str, *, credit_bucket: str | None = None,
        available_micros: int | None = None, required_micros: int | None = None,
    ) -> None:
        nonlocal structured_error_sent, state
        if structured_error_sent:
            return
        structured_error_sent = True
        state = VoiceState.ERROR
        payload: dict[str, Any] = {"code": code, "message": message, "turn_number": turn_number}
        if credit_bucket:
            payload["credit_bucket"] = credit_bucket
        if available_micros is not None:
            payload["available_micros"] = max(0, int(available_micros))
        if required_micros is not None:
            payload["required_micros"] = max(0, int(required_micros))
        try:
            await _voice_send(websocket, "error", **payload)
            await websocket.close(
                code=VOICE_CLOSE_CODES.get(code, VOICE_CLOSE_CODES["voice_internal_failure"]),
                reason=code if code in VOICE_CLOSE_CODES else "voice_internal_failure",
            )
        except (RuntimeError, WebSocketDisconnect):
            pass
        stop_event.set()

    async def provider_failure(exc: SarvamStreamingError) -> None:
        code = provider_error_code(exc.category)
        message = {
            "sarvam_authentication_failed": "Voice provider authentication failed. Please contact support.",
            "sarvam_quota_exhausted": "Voice provider quota is exhausted. Please try again later.",
            "sarvam_protocol_error": "Voice provider protocol is incompatible. Please try again later.",
        }.get(code, "Voice provider is temporarily unavailable. Try again with a fresh session.")
        await targeted_error(code, message)

    async def wallets_message() -> None:
        with SessionLocal() as billing_session:
            summaries = get_wallet_summaries(
                billing_session, metadata.user_id, swico_tier=metadata.tier,
                billing_exempt=metadata.billing_exempt,
            )
        await _voice_send(websocket, "wallet.updated", wallets=summaries)

    async def begin_stt_reservation(*, announce: bool) -> None:
        nonlocal current_stt_request, received_audio_bytes, stt_reserved_milliseconds
        nonlocal stt_reserved_micros, last_audio_sequence, stage
        if current_stt_request is not None:
            return
        stage = "stt_reservation"
        request_id = f"realtime-stt:{metadata.session_id}:{turn_number}"
        reserve = stt_price(5_000)
        try:
            with SessionLocal() as billing_session:
                enforce_rate_limit(
                    billing_session, user_id=metadata.user_id, action="realtime_voice_turn",
                    limit=int(os.getenv("WEB_STT_RATE_LIMIT_PER_MINUTE", "10")),
                )
                if metadata.billing_exempt:
                    create_billing_exempt_usage(
                        billing_session, request_id=request_id, user_id=metadata.user_id,
                        thread_id=None, provider="sarvam",
                        model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
                        pricing_snapshot_json=snapshot_json(reserve.snapshot), usage_kind="stt",
                        credit_bucket="voice", voice_turn_id=metadata.session_id,
                    )
                else:
                    create_usage_reservation(
                        billing_session, request_id=request_id, user_id=metadata.user_id,
                        thread_id=None, provider="sarvam",
                        model=os.getenv("SARVAM_STT_MODEL", "saaras:v3"),
                        reserved_micros=reserve.micros,
                        pricing_snapshot_json=snapshot_json(reserve.snapshot), usage_kind="stt",
                        credit_bucket="voice", voice_turn_id=metadata.session_id,
                    )
                billing_session.commit()
        except InsufficientCreditError as exc:
            await targeted_error(
                "insufficient_voice_credit", "Add Voice credits to continue.",
                credit_bucket="voice", available_micros=exc.available_micros,
                required_micros=exc.estimated_required_micros,
            )
            raise _VoiceTargetedStop from exc
        except RateLimitError as exc:
            await targeted_error(
                "voice_rate_limit", "Too many Voice Mode turns. Please wait a moment."
            )
            raise _VoiceTargetedStop from exc
        current_stt_request = request_id
        received_audio_bytes = 0
        last_audio_sequence = 0
        stt_reserved_milliseconds = 5_000
        stt_reserved_micros = reserve.micros
        if not provider.stt_connected:
            stage = "sarvam_stt_connect"
            try:
                await provider.connect_stt(metadata.language)
            except SarvamStreamingError as exc:
                with SessionLocal() as billing_session:
                    if metadata.billing_exempt:
                        release_billing_exempt_usage(billing_session, request_id, reason="provider_connect_failed")
                    else:
                        release_usage_reservation(billing_session, request_id, reason="provider_connect_failed")
                    billing_session.commit()
                current_stt_request = None
                await provider_failure(exc)
                raise _VoiceTargetedStop from exc
        if announce:
            await set_state(VoiceState.LISTENING)
            await _voice_send(websocket, "session.ready", state="listening", turn_number=turn_number)

    def settle_stt(request_id: str, actual_ms: int) -> None:
        actual = stt_price(actual_ms)
        with SessionLocal() as billing_session:
            settle = settle_billing_exempt_usage if metadata.billing_exempt else settle_usage_reservation
            settle(
                billing_session, request_id=request_id, provider_cost_amount=actual.amount,
                provider_cost_currency=actual.currency, provider_cost_micros=actual.micros,
                input_tokens=0, cached_input_tokens=0, output_tokens=0, usage_source="actual",
                pricing_snapshot_json=snapshot_json(actual.snapshot), usage_kind="stt",
                audio_milliseconds=actual_ms,
            )
            billing_session.commit()

    async def synthesize_stream(
        text_queue: asyncio.Queue[str | None], request_id: str, active_turn: int,
        latency: dict[str, float | int],
    ) -> None:
        nonlocal stage
        first_chunk = await text_queue.get()
        if first_chunk is None:
            return
        tts_model = normalize_sarvam_tts_model(os.getenv("SARVAM_TTS_MODEL"), premium=False)
        initial = tts_price(len(first_chunk), tts_model)
        try:
            with SessionLocal() as billing_session:
                create = create_billing_exempt_usage if metadata.billing_exempt else create_usage_reservation
                common = dict(
                    request_id=request_id, user_id=metadata.user_id, thread_id=None,
                    provider="sarvam", model=tts_model,
                    pricing_snapshot_json=snapshot_json(initial.snapshot), usage_kind="tts",
                    credit_bucket="voice", voice_turn_id=metadata.session_id,
                    characters=len(first_chunk),
                )
                if metadata.billing_exempt:
                    create(billing_session, **common)
                else:
                    create(billing_session, reserved_micros=initial.micros, **common)
                billing_session.commit()
        except InsufficientCreditError:
            await _voice_send(
                websocket, "warning", code="insufficient_voice_credit", credit_bucket="voice",
                message="Speech is unavailable; the completed text answer is preserved.",
            )
            return
        submitted = 0
        reserved_micros = initial.micros
        audio_reader: asyncio.Task[Any] | None = None
        chunks_sent = 0
        bytes_sent = 0

        def settle_or_release() -> None:
            with SessionLocal() as billing_session:
                if submitted:
                    consumed = tts_price(submitted, tts_model)
                    settle = settle_billing_exempt_usage if metadata.billing_exempt else settle_usage_reservation
                    settle(
                        billing_session, request_id=request_id,
                        provider_cost_amount=consumed.amount,
                        provider_cost_currency=consumed.currency,
                        provider_cost_micros=consumed.micros, input_tokens=0,
                        cached_input_tokens=0, output_tokens=0, usage_source="actual",
                        pricing_snapshot_json=snapshot_json(consumed.snapshot),
                        usage_kind="tts", characters=submitted,
                    )
                elif metadata.billing_exempt:
                    release_billing_exempt_usage(billing_session, request_id, reason="tts_unused")
                else:
                    release_usage_reservation(billing_session, request_id, reason="tts_unused")
                billing_session.commit()

        async def send_audio() -> None:
            nonlocal chunks_sent, bytes_sent
            async for audio_chunk in provider.tts_audio():
                if not audio_chunk:
                    raise SarvamStreamingError(
                        "Sarvam returned empty TTS audio.", category="protocol",
                        safe_code="invalid_audio_frame", retryable=False,
                    )
                if metadata.output_codec == "linear16" and len(audio_chunk) % 2:
                    raise SarvamStreamingError(
                        "Sarvam returned misaligned PCM audio.", category="protocol",
                        safe_code="invalid_audio_frame", retryable=False,
                    )
                chunks_sent += 1
                bytes_sent += len(audio_chunk)
                if "first_tts_audio_at" not in latency:
                    latency["first_tts_audio_at"] = time.monotonic()
                await websocket.send_bytes(chunks_sent.to_bytes(4, "big") + audio_chunk)

        try:
            stage = "sarvam_tts_connect"
            await provider.connect_tts(
                metadata.language, output_codec=metadata.output_codec,
                sample_rate=metadata.sample_rate,
            )
            await set_state(VoiceState.SPEAKING)
            await _voice_send(websocket, "audio.start", **_voice_audio_start(metadata, active_turn))
            stage = "tts_stream"
            audio_reader = asyncio.create_task(send_audio(), name="voice-tts-audio")
            chunk: str | None = first_chunk
            exhausted = False
            while chunk is not None:
                next_count = submitted + len(chunk)
                next_price = tts_price(next_count, tts_model)
                additional = max(0, next_price.micros - reserved_micros)
                if additional and not metadata.billing_exempt:
                    try:
                        with SessionLocal() as billing_session:
                            expand_usage_reservation(
                                billing_session, request_id=request_id,
                                additional_micros=additional, expansion_id=f"characters-{next_count}",
                            )
                            billing_session.commit()
                        reserved_micros = next_price.micros
                    except InsufficientCreditError:
                        exhausted = True
                        await _voice_send(
                            websocket, "warning", code="insufficient_voice_credit",
                            credit_bucket="voice",
                            message="Speech stopped; the completed text answer is preserved.",
                        )
                        break
                await provider.send_tts_text(chunk)
                submitted = next_count
                chunk = await text_queue.get()
            if exhausted:
                await provider.close_tts()
            else:
                await provider.flush_tts()
            if audio_reader:
                await audio_reader
            await _voice_send(websocket, "audio.end", **_voice_audio_end(
                metadata, active_turn, chunks_sent=chunks_sent, bytes_sent=bytes_sent,
                characters=submitted, interrupted=exhausted,
            ))
        except asyncio.CancelledError:
            await provider.close_tts()
            raise
        except SarvamStreamingError:
            await provider.close_tts()
            await _voice_send(
                websocket, "warning", code="tts_interrupted",
                message="Speech stopped; the completed text answer is preserved.",
            )
        finally:
            if audio_reader and not audio_reader.done():
                audio_reader.cancel()
                await asyncio.gather(audio_reader, return_exceptions=True)
            settle_or_release()

    async def process_turn(transcript: str, active_turn: int) -> None:
        nonlocal current_thread_id, generation_cancellation, tts_task, stage
        async with process_lock:
            if stop_event.is_set():
                return
            await set_state(VoiceState.THINKING)
            await _voice_send(websocket, "stt.final", transcript=transcript, turn_number=active_turn)
            await _voice_send(websocket, "assistant.start", turn_number=active_turn)
            latency = voice_latency_by_turn.setdefault(active_turn, {})
            stage = "chat_prepare"
            chat_request = f"realtime-chat:{metadata.session_id}:{active_turn}"
            try:
                prepared = await asyncio.to_thread(
                    prepare_web_turn, user_id=metadata.user_id, message=transcript,
                    request_id=chat_request, thread_id=current_thread_id,
                    reply_language=metadata.language, billing_exempt=metadata.billing_exempt,
                    input_mode="realtime_voice", voice_turn_id=metadata.session_id,
                    billing_credit_bucket="voice",
                )
            except InsufficientCreditError as exc:
                await targeted_error(
                    "insufficient_voice_credit", "Add Voice credits to continue Voice Mode.",
                    credit_bucket="voice", available_micros=exc.available_micros,
                    required_micros=exc.estimated_required_micros,
                )
                return
            generation_cancellation = GenerationCancellation()
            prepared.ai_request.metadata["cancellation_signal"] = generation_cancellation
            text_queue: asyncio.Queue[str | None] = asyncio.Queue()
            delta_queue: asyncio.Queue[str] = asyncio.Queue()
            tts_task = asyncio.create_task(
                synthesize_stream(
                    text_queue, f"realtime-tts:{metadata.session_id}:{active_turn}", active_turn,
                    latency,
                ),
                name="voice-tts",
            )
            loop = asyncio.get_running_loop()

            def delta(value: str) -> None:
                if "first_model_delta_at" not in latency:
                    latency["first_model_delta_at"] = time.monotonic()
                loop.call_soon_threadsafe(delta_queue.put_nowait, value)

            stage = "chat_generate"
            chat_task = asyncio.create_task(
                asyncio.to_thread(execute_web_turn, prepared, on_delta=delta), name="voice-chat"
            )
            completed = None
            pending_text = ""
            saw_delta = False
            try:
                while not chat_task.done() or not delta_queue.empty():
                    try:
                        value = await asyncio.wait_for(delta_queue.get(), timeout=0.05)
                    except asyncio.TimeoutError:
                        continue
                    saw_delta = True
                    pending_text += value
                    await _voice_send(websocket, "assistant.delta", delta=value, turn_number=active_turn)
                    chunks, pending_text = _voice_tts_chunks(pending_text)
                    for chunk in chunks:
                        text_queue.put_nowait(chunk)
                completed = await chat_task
                if completed.message.status == "complete":
                    if not saw_delta:
                        pending_text = completed.message.content
                        await _voice_send(
                            websocket, "assistant.delta", delta=pending_text, turn_number=active_turn
                        )
                    chunks, pending_text = _voice_tts_chunks(pending_text, final=True)
                    for chunk in chunks:
                        text_queue.put_nowait(chunk)
            except (GenerationCancelled, asyncio.CancelledError):
                if generation_cancellation:
                    generation_cancellation.cancel()
                if not chat_task.done():
                    await asyncio.gather(chat_task, return_exceptions=True)
                return
            finally:
                generation_cancellation = None
                text_queue.put_nowait(None)
                if tts_task:
                    await asyncio.gather(tts_task, return_exceptions=True)
                tts_task = None
            if completed is None or completed.message.status != "complete":
                return
            current_thread_id = completed.thread_id
            with SessionLocal() as message_session:
                user_message = message_session.exec(select(WebChatMessage).where(
                    WebChatMessage.user_id == metadata.user_id,
                    WebChatMessage.request_id == chat_request,
                    WebChatMessage.role == "user",
                    WebChatMessage.status == "complete",
                )).first()
            if user_message is None:
                return
            await wallets_message()
            await _voice_send(
                websocket, "turn.done", thread_id=completed.thread_id,
                user_message_id=user_message.id, assistant_message_id=completed.message.id,
                turn_number=active_turn, input_mode="realtime_voice", completion_status="complete",
                billing_credit_bucket=prepared.billing_credit_bucket,
                telemetry=_voice_latency_payload(latency),
            )
            logger.info("realtime_voice_turn_latency", extra={
                "event": "realtime_voice_turn_latency", "turn_number": active_turn,
                **_voice_latency_payload(latency),
            })
            if state not in {VoiceState.INTERRUPTED, VoiceState.ERROR, VoiceState.CLOSING}:
                await set_state(VoiceState.LISTENING)

    async def discard_short_turn() -> None:
        nonlocal current_stt_request, final_segments, last_partial, provider_audio_milliseconds
        nonlocal received_audio_bytes, utterance_started_at, speech_ended_at
        nonlocal transcript_updated_at
        request_id = current_stt_request
        if request_id:
            with SessionLocal() as billing_session:
                if metadata.billing_exempt:
                    release_billing_exempt_usage(billing_session, request_id, reason="empty_or_noise_only")
                else:
                    release_usage_reservation(billing_session, request_id, reason="empty_or_noise_only")
                billing_session.commit()
            current_stt_request = None
        final_segments = []
        last_partial = ""
        provider_audio_milliseconds = 0
        received_audio_bytes = 0
        utterance_started_at = None
        speech_ended_at = None
        transcript_updated_at = None
        prosody.reset()
        await _voice_send(websocket, "warning", code="empty_voice_turn", message="No clear speech was detected.")
        await begin_stt_reservation(announce=True)

    async def finalize_endpoint(*, explicit: bool = False, generation: int | None = None) -> None:
        nonlocal current_stt_request, final_segments, last_partial, provider_audio_milliseconds
        nonlocal received_audio_bytes, utterance_started_at, process_task, turn_number, stage
        nonlocal speech_ended_at, transcript_updated_at
        if generation is not None and generation != deadline_generation:
            return
        transcript = join_final_segments(final_segments) or (
            last_partial.strip() if explicit or endpoint.adaptive_enabled else ""
        )
        actual_ms = provider_audio_milliseconds or received_audio_bytes // 32
        if not transcript or actual_ms < endpoint.min_speech_ms:
            await discard_short_turn()
            return
        request_id = current_stt_request
        if request_id is None:
            return
        current_stt_request = None
        stage = "settlement"
        settle_stt(request_id, actual_ms)
        active_turn = turn_number
        latency = voice_latency_by_turn.setdefault(active_turn, {})
        latency["final_transcript_at"] = time.monotonic()
        turn_number += 1
        final_segments = []
        last_partial = ""
        provider_audio_milliseconds = 0
        received_audio_bytes = 0
        utterance_started_at = None
        speech_ended_at = None
        transcript_updated_at = None
        prosody.reset()
        # Reserve the next gated STT turn before thinking/speaking. This is what
        # makes authoritative provider-confirmed barge-in possible without ever
        # forwarding unreserved audio.
        await begin_stt_reservation(announce=False)
        process_task = asyncio.create_task(process_turn(transcript, active_turn), name="voice-turn")
        process_tasks.add(process_task)
        process_task.add_done_callback(process_tasks.discard)

    async def schedule_endpoint(*, explicit: bool = False, maximum: bool = False) -> None:
        nonlocal endpoint_task, deadline_generation, endpoint_cancel_count
        nonlocal endpoint_delay, endpoint_reason, endpoint_classification
        deadline_generation += 1
        scheduled_generation = deadline_generation
        if endpoint_task and not endpoint_task.done():
            endpoint_cancel_count += 1
            endpoint_task.cancel()
            await asyncio.gather(endpoint_task, return_exceptions=True)
        await set_state(VoiceState.ENDPOINT_PENDING)
        transcript = join_final_segments(final_segments) or last_partial
        now = time.monotonic()
        if endpoint.adaptive_enabled:
            summary = prosody.summary()
            utterance_ms = int((now - utterance_started_at) * 1000) if utterance_started_at else 0
            decision = decide_endpoint(EndpointEvidence(
                language=metadata.language,
                accumulated_transcript=join_final_segments(final_segments),
                latest_partial=last_partial,
                has_final_transcript=bool(final_segments),
                transcript_updated_at=transcript_updated_at,
                speech_started_at=utterance_started_at,
                speech_ended_at=speech_ended_at if speech_ended_at is not None else now,
                utterance_duration_ms=utterance_ms,
                terminal_cadence=summary.terminal_cadence,
                trailing_off=summary.trailing_off,
                voiced_duration_ms=summary.voiced_duration_ms,
                explicit_end=explicit,
                maximum_duration_reached=maximum or utterance_ms >= endpoint.max_utterance_ms,
                speech_active=False,
                deadline_generation=deadline_generation,
            ), EndpointTiming(
                endpoint.end_silence_ms, endpoint.unfinished_grace_ms,
                endpoint.max_endpoint_wait_ms, endpoint.max_utterance_ms,
            ), now=now)
            delay = decision.delay_ms
            endpoint_reason = decision.reason
            endpoint_classification = decision.transcript_classification.value
        else:
            delay = 0 if explicit else endpoint_delay_ms(transcript, metadata.language, endpoint)
            endpoint_reason = "explicit_end" if explicit else (
                "unfinished_sentence" if delay > endpoint.end_silence_ms else "complete_neutral"
            )
            endpoint_classification = "unfinished" if delay > endpoint.end_silence_ms else "neutral"
            if utterance_started_at is not None:
                remaining = endpoint.max_utterance_ms - int((now - utterance_started_at) * 1000)
                delay = max(0, min(delay, remaining))
        endpoint_delay = delay
        await endpoint_metadata()

        async def wait_and_finalize() -> None:
            nonlocal endpoint_task
            try:
                await asyncio.sleep(delay / 1000)
                if scheduled_generation != deadline_generation or state != VoiceState.ENDPOINT_PENDING:
                    return
                # Detach the committing timer before settlement begins. A
                # provider START_SPEECH arriving after this commit belongs to
                # the next turn and must not cancel settlement halfway through.
                endpoint_task = None
                await finalize_endpoint(explicit=explicit, generation=scheduled_generation)
            except asyncio.CancelledError:
                return
            except _VoiceTargetedStop:
                return
            except Exception as exc:
                diagnostic(exc)
                await targeted_error(
                    "voice_internal_failure",
                    "Voice Mode stopped safely. Try again with a fresh session.",
                )

        endpoint_task = asyncio.create_task(wait_and_finalize(), name="voice-endpoint")

    async def read_stt() -> None:
        nonlocal endpoint_task, last_partial, utterance_started_at, provider_audio_milliseconds
        nonlocal generation_cancellation, stage, tts_task, speech_ended_at
        nonlocal transcript_updated_at, deadline_generation, endpoint_cancel_count
        nonlocal endpoint_delay, endpoint_reason
        nonlocal last_barge_in_stop_latency_ms, last_backchannel_at
        stage = "microphone_stream"
        async for event in provider.stt_events():
            event_type = event.get("type")
            if event_type == "provider_warning":
                continue
            if event_type == "provider_error":
                exc = SarvamStreamingError(
                    "Sarvam STT stream closed.", category=str(event.get("category") or "temporary"),
                    safe_code=str(event.get("safe_code") or "unknown_provider_error"),
                    websocket_close_code=event.get("websocket_close_code"),
                    handshake_status=event.get("handshake_status"),
                    retryable=bool(event.get("retryable")),
                )
                diagnostic(exc)
                await provider_failure(exc)
                return
            if event_type == "speech_start":
                await _voice_send(websocket, "speech_start", turn_number=turn_number)
                if endpoint_task and not endpoint_task.done():
                    deadline_generation += 1
                    endpoint_cancel_count += 1
                    endpoint_task.cancel()
                    await asyncio.gather(endpoint_task, return_exceptions=True)
                speech_ended_at = None
                endpoint_delay = 0
                endpoint_reason = "speech_resumed"
                if utterance_started_at is None:
                    utterance_started_at = time.monotonic()
                    voice_latency_by_turn.setdefault(turn_number, {})["speech_started_at"] = utterance_started_at
                if state in {VoiceState.THINKING, VoiceState.SPEAKING}:
                    barge_started = time.monotonic()
                    if generation_cancellation:
                        generation_cancellation.cancel()
                    if tts_task and not tts_task.done():
                        tts_task.cancel()
                    await provider.close_tts()
                    last_barge_in_stop_latency_ms = int((time.monotonic() - barge_started) * 1000)
                    voice_latency_by_turn.setdefault(max(1, turn_number - 1), {})[
                        "barge_in_stop_latency_ms"
                    ] = last_barge_in_stop_latency_ms
                    await set_state(VoiceState.INTERRUPTED)
                    await _voice_send(
                        websocket, "warning", code="assistant_interrupted",
                        message="Assistant interrupted. Listening now.",
                    )
                await set_state(VoiceState.LISTENING)
                await endpoint_metadata()
                continue
            if event_type == "speech_end":
                stage = "endpoint_pending"
                speech_ended_at = time.monotonic()
                await schedule_endpoint()
                continue
            if event_type == "partial":
                next_partial = str(event.get("transcript") or "").strip()
                if next_partial != last_partial:
                    last_partial = next_partial
                    transcript_updated_at = time.monotonic()
                    latency = voice_latency_by_turn.setdefault(turn_number, {})
                    latency.setdefault("first_partial_at", transcript_updated_at)
                await _voice_send(
                    websocket, "stt.partial", transcript=last_partial, turn_number=turn_number
                )
                backchannel_now = time.monotonic()
                backchannel_classification = classify_transcript(
                    join_final_segments(final_segments), metadata.language,
                    latest_partial=last_partial, has_final_transcript=bool(final_segments),
                    transcript_updated_at=transcript_updated_at, now=backchannel_now,
                )
                if _voice_backchannel_due(
                    enabled=_env_enabled("WEB_REALTIME_VOICE_BACKCHANNEL_ENABLED"),
                    state=state, utterance_started_at=utterance_started_at,
                    last_backchannel_at=last_backchannel_at, now=backchannel_now,
                    classification=backchannel_classification,
                ):
                    last_backchannel_at = backchannel_now
                    await _voice_send(websocket, "backchannel", cue="listening", turn_number=turn_number)
                if endpoint.adaptive_enabled and state == VoiceState.ENDPOINT_PENDING:
                    await schedule_endpoint()
                continue
            if event_type == "final":
                segment = str(event.get("transcript") or "").strip()
                appended = append_final_segment(final_segments, segment)
                if appended:
                    provider_audio_milliseconds += max(0, int(event.get("audio_milliseconds") or 0))
                    transcript_updated_at = time.monotonic()
                last_partial = ""
                if not appended:
                    continue
                stage = "endpoint_pending"
                if speech_ended_at is None:
                    speech_ended_at = time.monotonic()
                await schedule_endpoint()

    async def forward_audio(data: bytes) -> None:
        nonlocal last_audio_sequence, received_audio_bytes, stt_reserved_milliseconds
        nonlocal stt_reserved_micros, current_stt_request, stage, audio_message_count
        # Browser frames are exactly 512 mono int16 samples plus a 4-byte sequence.
        if len(data) != 4 + 512 * 2:
            await _voice_send(websocket, "error", code="invalid_audio_chunk", message="Audio chunk rejected.")
            return
        sequence = int.from_bytes(data[:4], "big")
        if sequence <= last_audio_sequence:
            await _voice_send(
                websocket, "warning", code="duplicate_audio_chunk", message="Duplicate audio chunk ignored."
            )
            return
        if current_stt_request is None:
            # Never forward provider audio without an active reservation/audit row.
            await _voice_send(websocket, "warning", code="audio_not_reserved", message="Audio chunk ignored.")
            return
        proposed_bytes = received_audio_bytes + len(data) - 4
        required_ms = max(1, (proposed_bytes + 31) // 32)
        if required_ms > stt_reserved_milliseconds:
            next_reserved_ms = ((required_ms + 4_999) // 5_000) * 5_000
            next_price = stt_price(next_reserved_ms)
            additional = max(0, next_price.micros - stt_reserved_micros)
            if additional and not metadata.billing_exempt:
                try:
                    with SessionLocal() as billing_session:
                        expand_usage_reservation(
                            billing_session, request_id=current_stt_request,
                            additional_micros=additional,
                            expansion_id=f"audio-ms-{next_reserved_ms}",
                        )
                        billing_session.commit()
                except InsufficientCreditError as exc:
                    await targeted_error(
                        "insufficient_voice_credit", "Add Voice credits to continue.",
                        credit_bucket="voice", available_micros=exc.available_micros,
                        required_micros=exc.estimated_required_micros,
                    )
                    raise _VoiceTargetedStop from exc
            stt_reserved_milliseconds = next_reserved_ms
            stt_reserved_micros = next_price.micros
        stage = "microphone_stream"
        await provider.send_audio(data[4:])
        received_audio_bytes = proposed_bytes
        last_audio_sequence = sequence
        audio_message_count += 1
        if endpoint.adaptive_enabled:
            prosody.accept_pcm_frame(data[4:], int((time.monotonic() - started_at) * 1000))
        if endpoint.adaptive_enabled and utterance_started_at is not None and (
            time.monotonic() - utterance_started_at
        ) * 1000 >= endpoint.max_utterance_ms:
            await schedule_endpoint(maximum=True)

    try:
        stage = "session_started"
        await _voice_send(
            websocket, "session.ready", state="connected", session_id=metadata.session_id,
            tier=metadata.tier, tier_label=SWICO_TIER_LABELS[metadata.tier], language=metadata.language,
            audio_mime_type="audio/mpeg", preroll_ms=endpoint.preroll_ms,
            barge_in_min_ms=endpoint.barge_in_min_ms,
        )
        while not stop_event.is_set():
            remaining = max_session - (time.monotonic() - started_at)
            if remaining <= 0:
                await _voice_send(websocket, "session.closed", reason="maximum_duration")
                await websocket.close(
                    code=VOICE_CLOSE_CODES["voice_maximum_duration"], reason="voice_maximum_duration"
                )
                break
            receive_task = asyncio.create_task(websocket.receive(), name="voice-client-receive")
            stop_waiter = asyncio.create_task(stop_event.wait(), name="voice-stop-waiter")
            done, pending = await asyncio.wait(
                {receive_task, stop_waiter}, timeout=min(idle_timeout, remaining),
                return_when=asyncio.FIRST_COMPLETED,
            )
            for pending_task in pending:
                pending_task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            if stop_waiter in done and stop_event.is_set():
                if receive_task in done:
                    await asyncio.gather(receive_task, return_exceptions=True)
                break
            if receive_task not in done:
                maximum = time.monotonic() - started_at >= max_session
                code = "voice_maximum_duration" if maximum else "voice_idle_timeout"
                await _voice_send(websocket, "session.closed", reason="maximum_duration" if maximum else "idle_timeout")
                await websocket.close(code=VOICE_CLOSE_CODES[code], reason=code)
                break
            incoming = receive_task.result()
            if incoming.get("type") == "websocket.disconnect":
                stage = "client_disconnect"
                break
            if incoming.get("bytes") is not None:
                await forward_audio(incoming["bytes"])
                continue
            try:
                payload = json.loads(incoming.get("text") or "{}")
            except json.JSONDecodeError:
                await targeted_error("voice_protocol_mismatch", "Voice protocol mismatch. Start a fresh session.")
                break
            if int(payload.get("protocol_version") or 0) != 1:
                await targeted_error("voice_protocol_mismatch", "Voice protocol mismatch. Start a fresh session.")
                break
            event_type = payload.get("type")
            if event_type == "session.start" and current_stt_request is None:
                supplied_thread = payload.get("thread_id")
                current_thread_id = str(supplied_thread) if supplied_thread else None
                await begin_stt_reservation(announce=True)
                if stt_task is None:
                    stt_task = asyncio.create_task(read_stt(), name="voice-stt-reader")
            elif event_type == "turn.end":
                await provider.flush_stt()
                await schedule_endpoint(explicit=True)
            elif event_type == "interrupt":
                # Browser RMS is only a gate/cue. Provider START_SPEECH is the
                # authoritative event that actually interrupts an answer.
                continue
            elif event_type == "mute" or event_type == "unmute":
                continue
            elif event_type == "ping":
                await _voice_send(websocket, "pong")
            elif event_type == "session.close":
                client_closed = True
                state = VoiceState.CLOSING
                await _voice_send(websocket, "session.closed", reason="client_closed")
                await websocket.close(code=1000, reason="client_closed")
                break
    except _VoiceTargetedStop:
        pass
    except WebSocketDisconnect:
        stage = "client_disconnect"
    except SarvamStreamingError as exc:
        diagnostic(exc)
        await provider_failure(exc)
    except Exception as exc:
        diagnostic(exc)
        if not structured_error_sent:
            await targeted_error(
                "voice_internal_failure",
                "Voice Mode stopped safely. Try again with a fresh session.",
            )
    finally:
        stage = "settlement"
        if generation_cancellation:
            generation_cancellation.cancel()
        for task in (endpoint_task, tts_task):
            if task and not task.done():
                task.cancel()
        # The STT reader owns no settlement and is safe to cancel. The chat
        # worker receives cooperative cancellation and is awaited before lock release.
        if stt_task and not stt_task.done():
            stt_task.cancel()
        if process_task and not process_task.done():
            if generation_cancellation:
                generation_cancellation.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(process_task), timeout=10)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                process_task.cancel()
        for task in tuple(process_tasks):
            if not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (endpoint_task, stt_task, process_task, tts_task, *process_tasks) if task),
            return_exceptions=True,
        )
        await provider.close()
        if current_stt_request:
            with SessionLocal() as billing_session:
                if metadata.billing_exempt:
                    release_billing_exempt_usage(
                        billing_session, current_stt_request, reason="voice_disconnect"
                    )
                else:
                    release_usage_reservation(
                        billing_session, current_stt_request, reason="voice_disconnect"
                    )
                billing_session.commit()
            reservations_released = True
            current_stt_request = None
        await asyncio.to_thread(_tickets().release, metadata)
        cleanup_succeeded = True
        state = VoiceState.CLOSED
        diagnostic(cleanup=cleanup_succeeded)
        if not client_closed:
            try:
                await websocket.close()
            except RuntimeError:
                pass


def _profile_response(user) -> dict[str, Any]:
    return {
        "name": user.name, "place": user.place, "timezone": user.timezone,
        "assistant_name": user.assistant_name, "reply_language": user.reply_language,
        "email": user.email, "email_editable": False,
    }


@router.get("/settings/profile")
def get_profile_settings(
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    return _profile_response(get_owned_user(session, auth))


@router.patch("/settings/profile")
def patch_profile_settings(
    payload: ProfilePatch, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    fields = payload.model_fields_set
    for required in ("name", "timezone", "assistant_name", "reply_language"):
        if required in fields and getattr(payload, required) is None:
            raise HTTPException(422, {"code": "invalid_profile", "message": f"{required} cannot be null."})
    if "timezone" in fields:
        try:
            validated_timezone(str(payload.timezone))
        except ValueError as exc:
            raise HTTPException(422, {"code": "invalid_timezone", "message": str(exc)}) from exc
    for field in ("name", "place", "timezone", "assistant_name", "reply_language"):
        if field in fields:
            setattr(user, field, getattr(payload, field))
    session.add(user)
    session.flush()
    return _profile_response(user)


@router.get("/settings/assistant")
def get_assistant_settings(
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    internal_account = is_internal_test_user(auth, user)
    free_available = swico_free_eligible(
        int(user.id), internal_account=internal_account,
    )
    tier = selected_swico_tier(session, int(user.id))
    if tier == "free" and not free_available:
        tier = "lite"
    return public_tier_settings(tier, free_available=free_available)


@router.patch("/settings/assistant")
def patch_assistant_settings(
    payload: AssistantSettingsPatch, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    internal_account = is_internal_test_user(auth, user)
    if not tier_selection_enabled():
        raise HTTPException(403, {
            "code": "tier_selection_disabled",
            "message": "Swico mode selection is temporarily unavailable.",
        })
    if payload.tier == "free" and not swico_free_eligible(
        int(user.id), internal_account=internal_account,
    ):
        raise HTTPException(422, {
            "code": "tier_unavailable",
            "message": "Swico Free is not available for this account yet.",
        })
    if payload.tier == "pro" and not pro_enabled():
        raise HTTPException(422, {
            "code": "tier_unavailable",
            "message": "Swico Pro is not available yet.",
        })
    row = session.exec(select(WebUsagePreferences).where(
        WebUsagePreferences.user_id == int(user.id)
    ).with_for_update()).first()
    if row is None:
        row = WebUsagePreferences(user_id=int(user.id), assistant_tier=payload.tier)
    else:
        row.assistant_tier = payload.tier
    row.updated_at = utc_now()
    session.add(row)
    # The client may issue a chat request as soon as this response arrives. Make
    # the selected tier durable before returning so that request preparation
    # cannot observe the previous committed value from another DB session.
    session.commit()
    session.refresh(row)
    return public_tier_settings(
        row.assistant_tier,
        free_available=swico_free_eligible(
            int(user.id), internal_account=internal_account,
        ),
    )


def _memory_settings_payload(session: Session, user_id: int) -> dict[str, Any]:
    available = _env_enabled("WEB_CROSS_THREAD_MEMORY_ENABLED")
    preferences = session.exec(select(WebUsagePreferences).where(
        WebUsagePreferences.user_id == user_id
    )).first()
    rows = session.exec(select(WebMemoryFact).where(
        WebMemoryFact.user_id == user_id,
        WebMemoryFact.deleted_at.is_(None),
    ).order_by(WebMemoryFact.updated_at.desc()).limit(100)).all()
    return {
        "available": available,
        "enabled": bool(available and preferences and preferences.memory_enabled),
        "items": [{
            "id": row.id, "value_text": row.value_text,
            "category": row.category, "created_at": row.created_at,
            "updated_at": row.updated_at,
        } for row in rows],
    }


@router.get("/settings/memory")
def get_memory_settings(
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    return _memory_settings_payload(session, int(user.id))


@router.patch("/settings/memory")
def patch_memory_settings(
    payload: MemorySettingsPatch, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    if payload.enabled and not _env_enabled("WEB_CROSS_THREAD_MEMORY_ENABLED"):
        return _temporary_error(503, "web_memory_disabled", "Cross-chat memory is not available.")
    row = session.exec(select(WebUsagePreferences).where(
        WebUsagePreferences.user_id == int(user.id)
    ).with_for_update()).first()
    if row is None:
        row = WebUsagePreferences(user_id=int(user.id))
    row.memory_enabled = payload.enabled
    row.updated_at = utc_now()
    session.add(row)
    session.flush()
    return _memory_settings_payload(session, int(user.id))


@router.delete("/settings/memory/{memory_id}", status_code=204)
def delete_memory_fact(
    memory_id: str, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    row = session.exec(select(WebMemoryFact).where(
        WebMemoryFact.id == memory_id,
        WebMemoryFact.user_id == int(user.id),
        WebMemoryFact.deleted_at.is_(None),
    )).first()
    if row is None:
        raise HTTPException(404, "Memory not found")
    row.deleted_at = utc_now()
    row.updated_at = utc_now()
    session.add(row)
    return None


@router.delete("/settings/memory", status_code=204)
def clear_memory(
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    now = utc_now()
    session.exec(sa_update(WebMemoryFact).where(
        WebMemoryFact.user_id == int(user.id),
        WebMemoryFact.deleted_at.is_(None),
    ).values(deleted_at=now, updated_at=now))
    session.exec(sa_delete(WebConversationSummary).where(
        WebConversationSummary.user_id == int(user.id)
    ))
    return None


@router.get("/settings/usage")
def get_usage_settings(
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    return usage_preferences_dict(
        session, user=user, billing_exempt=is_internal_test_user(auth, user),
    )


@router.patch("/settings/usage")
def patch_usage_settings(
    payload: UsagePreferencesPatch, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    row = session.exec(select(WebUsagePreferences).where(
        WebUsagePreferences.user_id == int(user.id)
    ).with_for_update()).first()
    if row is None:
        row = WebUsagePreferences(user_id=int(user.id))
    fields = payload.model_fields_set
    if "hard_limit_micros" in fields and "hard_limit_estimated_tokens" in fields:
        raise HTTPException(422, {"code": "invalid_usage_preferences", "message": "Set only one monthly-limit representation."})
    for required in ("period", "warning_threshold_percent", "notify_at_threshold"):
        if required in fields and getattr(payload, required) is None:
            raise HTTPException(422, {"code": "invalid_usage_preferences", "message": f"{required} cannot be null."})
    for field in ("period", "hard_limit_micros", "warning_threshold_percent", "notify_at_threshold"):
        if field in fields:
            setattr(row, field, getattr(payload, field))
    if "hard_limit_estimated_tokens" in fields:
        estimated_tokens = payload.hard_limit_estimated_tokens
        try:
            row.hard_limit_micros = (
                None if estimated_tokens is None else micros_for_blended_tokens(
                    estimated_tokens, tier=selected_swico_tier(session, int(user.id))
                )
            )
            if estimated_tokens is not None and row.hard_limit_micros <= 0:
                raise ValueError("reference pricing is not chargeable")
        except Exception as exc:
            raise HTTPException(422, {
                "code": "token_estimate_unavailable",
                "message": "The reference pricing needed for an estimated token limit is unavailable.",
            }) from exc
    row.updated_at = utc_now()
    session.add(row)
    session.flush()
    return usage_preferences_dict(
        session, user=user, row=row,
        billing_exempt=is_internal_test_user(auth, user),
    )


@router.get("/usage/summary")
def get_usage_summary(
    period: str = Query("current_month", pattern="^(current_month|30d|all)$"),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    return usage_summary(
        session, user=user, period=period,
        billing_exempt=is_internal_test_user(auth, user),
    )


@router.get("/threads")
def list_threads(
    archived: bool = False, q: str | None = Query(None, max_length=120),
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    condition = WebChatThread.archived_at.is_not(None) if archived else WebChatThread.archived_at.is_(None)
    statement = select(WebChatThread).where(WebChatThread.user_id == user.id, condition)
    if q and q.strip():
        statement = statement.where(WebChatThread.title.ilike(f"%{q.strip()}%"))
    rows = session.exec(statement.order_by(WebChatThread.updated_at.desc()).offset(offset).limit(limit + 1)).all()
    return {
        "items": [_serialize_thread(row) for row in rows[:limit]], "limit": limit,
        "offset": offset, "has_more": len(rows) > limit,
    }


@router.post("/threads", status_code=201)
def create_thread(payload: ThreadCreate, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    _rate_limit(session, user_id=int(user.id), action="thread_mutation", limit=30)
    row = WebChatThread(user_id=int(user.id), title=payload.title)
    session.add(row)
    session.flush()
    return _serialize_thread(row)


@router.get("/threads/{thread_id}")
def get_thread(thread_id: str, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    return _serialize_thread(_owned_thread(session, int(user.id), thread_id))


@router.patch("/threads/{thread_id}")
def patch_thread(payload: ThreadPatch, thread_id: str, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    _rate_limit(session, user_id=int(user.id), action="thread_mutation", limit=30)
    row = _owned_thread(session, int(user.id), thread_id)
    if payload.title is not None:
        row.title = payload.title
    if payload.archived is not None:
        row.archived_at = utc_now() if payload.archived else None
    row.updated_at = utc_now()
    session.add(row)
    return _serialize_thread(row)


@router.delete("/threads/{thread_id}", status_code=204)
def delete_thread(thread_id: str, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    _rate_limit(session, user_id=int(user.id), action="thread_mutation", limit=30)
    row = _owned_thread(session, int(user.id), thread_id)
    session.exec(sa_update(UsageCharge).where(UsageCharge.thread_id == row.id).values(thread_id=None, assistant_message_id=None))
    session.exec(sa_delete(WebChatMessage).where(WebChatMessage.thread_id == row.id))
    session.delete(row)
    return None


@router.get("/threads/{thread_id}/messages")
def list_messages(
    thread_id: str, response: Response,
    limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    response.headers["Cache-Control"] = "no-store"
    user = get_owned_user(session, auth)
    _owned_thread(session, int(user.id), thread_id)
    rows = session.exec(select(WebChatMessage).where(
        WebChatMessage.thread_id == thread_id, WebChatMessage.user_id == user.id,
        WebChatMessage.superseded_at.is_(None),
    ).order_by(WebChatMessage.created_at.asc()).offset(offset).limit(limit)).all()
    attachment_cache: dict[str, tuple[str, int | None]] = {}
    public_rows = []
    for row in rows:
        try:
            row_metadata = json.loads(row.metadata_json or "{}")
        except (TypeError, ValueError):
            row_metadata = {}
        if (
            row.role == "user"
            and isinstance(row_metadata, dict)
            and row_metadata.get("is_continuation_control")
        ):
            continue
        public_rows.append(row)
    return {
        "items": [
            _serialize_message(row, attachment_cache)
            for row in public_rows
        ],
        "limit": limit,
        "offset": offset,
    }


def _search_snippet(content: str, query: str) -> str:
    compact = " ".join(str(content or "").split())
    if not compact:
        return ""
    index = compact.casefold().find(query.casefold())
    if index < 0:
        query_terms = re.findall(r"[\w\u0B80-\u0BFF]+", query.casefold())
        index = next(
            (
                compact.casefold().find(term)
                for term in query_terms
                if compact.casefold().find(term) >= 0
            ),
            0,
        )
    start = max(0, index - 80)
    end = min(len(compact), index + len(query) + 80)
    return ("…" if start else "") + compact[start:end] + ("…" if end < len(compact) else "")


@router.get("/search")
def search_web_content(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(20, ge=1, le=50),
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    if not _env_enabled("WEB_CONTENT_SEARCH_ENABLED"):
        raise HTTPException(404, "Search is not enabled")
    user = get_owned_user(session, auth)
    query = " ".join(q.split()).strip()
    dialect = str(getattr(session.get_bind().dialect, "name", "")).lower()
    results: list[dict[str, Any]] = []
    if dialect.startswith("postgres"):
        rows = session.exec(
            text(
                """
                SELECT m.thread_id, m.id AS message_id, m.content,
                       'message' AS source_kind, m.created_at AS updated_at,
                       ts_rank_cd(to_tsvector('simple', m.content),
                                  websearch_to_tsquery('simple', :query)) AS rank
                FROM web_chat_message m
                JOIN web_chat_thread t ON t.id = m.thread_id
                WHERE m.user_id = :user_id AND m.superseded_at IS NULL
                  AND m.status = 'complete' AND t.archived_at IS NULL
                  AND (
                      COALESCE(m.metadata_json, '{}')::jsonb
                      ->> 'is_continuation_control'
                  ) IS DISTINCT FROM 'true'
                  AND to_tsvector('simple', m.content) @@ websearch_to_tsquery('simple', :query)
                UNION ALL
                SELECT s.thread_id, NULL AS message_id, s.summary_text AS content,
                       'summary' AS source_kind, s.updated_at,
                       ts_rank_cd(to_tsvector('simple', s.summary_text || ' ' || s.keywords_text),
                                  websearch_to_tsquery('simple', :query)) AS rank
                FROM web_conversation_summary s
                JOIN web_chat_thread t ON t.id = s.thread_id
                WHERE s.user_id = :user_id AND t.archived_at IS NULL
                  AND to_tsvector('simple', s.summary_text || ' ' || s.keywords_text)
                      @@ websearch_to_tsquery('simple', :query)
                UNION ALL
                SELECT f.source_thread_id AS thread_id,
                       f.source_message_id AS message_id,
                       f.value_text AS content, 'memory' AS source_kind,
                       f.updated_at,
                       ts_rank_cd(to_tsvector('simple', f.value_text),
                                  websearch_to_tsquery('simple', :query)) AS rank
                FROM web_memory_fact f
                LEFT JOIN web_chat_thread t ON t.id = f.source_thread_id
                LEFT JOIN web_chat_message sm ON sm.id = f.source_message_id
                WHERE f.user_id = :user_id AND f.deleted_at IS NULL
                  AND (f.source_thread_id IS NULL OR
                       (t.id IS NOT NULL AND t.archived_at IS NULL))
                  AND (f.source_message_id IS NULL OR
                       (sm.id IS NOT NULL AND sm.status = 'complete'
                        AND sm.superseded_at IS NULL))
                  AND to_tsvector('simple', f.value_text) @@ websearch_to_tsquery('simple', :query)
                ORDER BY rank DESC, updated_at DESC
                LIMIT :limit
                """
            ),
            params={
                "query": query,
                "user_id": int(user.id),
                "limit": limit,
            },
        ).all()
        for row in rows:
            value = getattr(row, "_mapping", row)
            results.append(
                {
                    "thread_id": value["thread_id"],
                    "message_id": value["message_id"],
                    "snippet": _search_snippet(value["content"], query),
                    "source_kind": value["source_kind"],
                    "updated_at": value["updated_at"],
                    "rank": float(value["rank"] or 0.0),
                }
            )
    else:
        pattern = f"%{query}%"
        active_thread_ids = list(session.exec(
            select(WebChatThread.id).where(
                WebChatThread.user_id == user.id,
                WebChatThread.archived_at.is_(None),
            )
        ).all())
        messages = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.user_id == user.id,
                WebChatMessage.thread_id.in_(active_thread_ids),
                WebChatMessage.status == "complete",
                WebChatMessage.superseded_at.is_(None),
                WebChatMessage.content.ilike(pattern),
            )
        ).all()
        summaries = session.exec(
            select(WebConversationSummary).where(
                WebConversationSummary.user_id == user.id,
                WebConversationSummary.thread_id.in_(active_thread_ids),
                or_(
                    WebConversationSummary.summary_text.ilike(pattern),
                    WebConversationSummary.keywords_text.ilike(pattern),
                ),
            )
        ).all()
        facts = session.exec(
            select(WebMemoryFact).where(
                WebMemoryFact.user_id == user.id,
                WebMemoryFact.deleted_at.is_(None),
                or_(
                    WebMemoryFact.source_thread_id.is_(None),
                    WebMemoryFact.source_thread_id.in_(active_thread_ids),
                ),
                WebMemoryFact.value_text.ilike(pattern),
            )
        ).all()
        facts = [
            row for row in facts
            if not row.source_message_id
            or (
                (source := session.exec(select(WebChatMessage).where(
                    WebChatMessage.id == row.source_message_id,
                    WebChatMessage.user_id == user.id,
                )).first())
                is not None
                and source.status == "complete"
                and source.superseded_at is None
            )
        ]
        for row in messages:
            if continuation_metadata_dict(row).get(
                "is_continuation_control"
            ):
                continue
            results.append(
                {
                    "thread_id": row.thread_id,
                    "message_id": row.id,
                    "snippet": _search_snippet(row.content, query),
                    "source_kind": "message",
                    "updated_at": row.created_at,
                    "rank": 1.0,
                }
            )
        for row in summaries:
            results.append(
                {
                    "thread_id": row.thread_id,
                    "message_id": None,
                    "snippet": _search_snippet(
                        f"{row.summary_text} {row.keywords_text}", query
                    ),
                    "source_kind": "summary",
                    "updated_at": row.updated_at,
                    "rank": 0.8,
                }
            )
        for row in facts:
            results.append(
                {
                    "thread_id": row.source_thread_id,
                    "message_id": row.source_message_id,
                    "snippet": _search_snippet(row.value_text, query),
                    "source_kind": "memory",
                    "updated_at": row.updated_at,
                    "rank": 0.7,
                }
            )
        results.sort(
            key=lambda item: (item["rank"], item["updated_at"]), reverse=True
        )
        results = results[:limit]
    return {"items": results, "query": query, "limit": limit}


@router.post("/messages/{message_id}/feedback")
def message_feedback(
    message_id: str,
    payload: MessageFeedbackRequest,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    if not _env_enabled("WEB_ANSWER_FEEDBACK_ENABLED"):
        raise HTTPException(404, "Feedback is not enabled")
    user = get_owned_user(session, auth)
    message = session.exec(
        select(WebChatMessage).where(
            WebChatMessage.id == message_id,
            WebChatMessage.user_id == user.id,
            WebChatMessage.role == "assistant",
        )
    ).first()
    if message is None:
        raise HTTPException(404, "Message not found")
    feedback = session.exec(
        select(WebMessageFeedback).where(
            WebMessageFeedback.user_id == user.id,
            WebMessageFeedback.message_id == message.id,
        )
    ).first()
    previous = feedback.rating if feedback is not None else None
    if feedback is None:
        feedback = WebMessageFeedback(
            user_id=int(user.id), message_id=message.id, rating=payload.rating
        )
    else:
        feedback.rating = payload.rating
        feedback.updated_at = utc_now()
    session.add(feedback)

    try:
        metadata = json.loads(message.metadata_json or "{}")
    except (TypeError, ValueError):
        metadata = {}
    metadata = metadata if isinstance(metadata, dict) else {}
    metadata["feedback_rating"] = payload.rating
    message.metadata_json = json.dumps(metadata, sort_keys=True, separators=(",", ":"))
    session.add(message)
    session.commit()

    cache_confidence: float | None = None
    tombstoned = False
    if previous != payload.rating:
        from ..ai.agents.feedback_quality_agent import FeedbackQualityAgent

        quality = FeedbackQualityAgent()
        if payload.rating == "down":
            result = quality.apply_message_negative_once(
                session, message, action="feedback_down", amount=0.25
            )
        else:
            result = quality.apply_message_positive_once(
                session, message, action="feedback_up", amount=0.10
            )
        if result is not None:
            cache_confidence = result.confidence
            tombstoned = result.tombstoned
    return {
        "message_id": message.id,
        "rating": payload.rating,
        "cache_confidence": cache_confidence,
        "cache_tombstoned": tombstoned,
    }


async def _save_temporary_upload(file: UploadFile, *, limit: int, suffix: str) -> tuple[str, int]:
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    path = handle.name
    size = 0
    try:
        while True:
            chunk = await file.read(64 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise DocumentValidationError(
                    "file_too_large", "The uploaded file exceeds the configured size limit.", status_code=413
                )
            handle.write(chunk)
        handle.flush()
        handle.close()
        return path, size
    except BaseException:
        handle.close()
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    finally:
        await file.close()


def _knowledge_library_unavailable() -> JSONResponse:
    return _temporary_error(
        404,
        "knowledge_library_unavailable",
        "Knowledge Library is unavailable.",
    )


@router.post(
    "/knowledge",
    status_code=201,
    response_model=KnowledgeDocumentResultResponse,
)
def approve_knowledge_document(
    payload: KnowledgeApprovalRequest,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rollout, _settings = _web_rollout(auth, user)
    if not rollout.knowledge_library.enabled:
        return _knowledge_library_unavailable()
    try:
        store = get_upload_store()
        # This owner-scoped marker is checked before the raw upload value is
        # fetched, so another user's identifier cannot expose source text.
        if not store.is_owned(str(payload.upload_id), int(user.id)):
            return _temporary_error(
                404,
                "upload_expired_or_not_found",
                "The temporary document expired or was not found.",
            )
        upload = store.get(str(payload.upload_id))
    except UploadStoreUnavailable:
        return _temporary_error(
            503,
            "attachment_cache_unavailable",
            "Temporary attachments are unavailable. Please try again later.",
        )
    if upload is None or upload.owner_user_id != int(user.id):
        return _temporary_error(
            404,
            "upload_expired_or_not_found",
            "The temporary document expired or was not found.",
        )
    if not upload.chunks:
        return _temporary_error(
            422,
            "no_extractable_text",
            "This document has no text that can be saved.",
        )

    source_id = f"upload:{upload.id}"
    if payload.replace_document_id is not None:
        try:
            previous = owned_knowledge_document(
                session,
                owner_user_id=int(user.id),
                document_id=str(payload.replace_document_id),
            )
        except PermissionError:
            return _temporary_error(
                404, "knowledge_document_not_found", "Document not found."
            )
        source_id = previous.source_id
    source_version = upload_content_hash(upload)
    chunks = tuple(
        ApprovedKnowledgeChunk(
            text=chunk.text,
            locator=safe_locator(upload, index),
            section_path=chunk.source[:512],
        )
        for index, chunk in enumerate(upload.chunks)
    )
    approval_key = f"knowledge-approval:{source_id}:{source_version}"
    try:
        document = approve_persistent_knowledge(
            session,
            owner_user_id=int(user.id),
            source_id=source_id,
            source_version=source_version,
            title=upload.name,
            chunks=chunks,
            user_approved=payload.confirm_persistence,
            idempotency_key=approval_key,
            source_kind="approved_document",
            safe_metadata={
                "attachment_count": 1,
                "attachment_bytes": upload.size_bytes,
                "attachment_media_categories": [
                    upload.media_type.split("/", 1)[0]
                    if "/" in upload.media_type else "other"
                ],
                "has_extracted_attachment_chunks": bool(upload.chunks),
            },
        )
    except IntegrityError:
        # A concurrent retry may win the owner/idempotency constraint. Catch
        # the database exception here so its raw chunk parameters never reach
        # request logs, then resolve the authoritative owner-scoped row.
        session.rollback()
        document = session.exec(
            select(WebKnowledgeDocument).where(
                WebKnowledgeDocument.owner_user_id == int(user.id),
                WebKnowledgeDocument.idempotency_key == approval_key,
                WebKnowledgeDocument.deleted_at.is_(None),
            )
        ).first()
        if document is None:
            return _temporary_error(
                503,
                "knowledge_storage_unavailable",
                "The document could not be saved right now.",
            )
    except (PermissionError, ValueError):
        session.rollback()
        return _temporary_error(
            422,
            "knowledge_approval_rejected",
            "The document could not be saved to your Knowledge Library.",
        )
    except SQLAlchemyError:
        session.rollback()
        return _temporary_error(
            503,
            "knowledge_storage_unavailable",
            "The document could not be saved right now.",
        )
    try:
        job = enqueue_knowledge_job(
            session,
            owner_user_id=int(user.id),
            job_type="web_knowledge_ingest",
            document_id=document.id,
            source_version=document.source_version,
            idempotency_key=f"knowledge-ingest:{document.id}:{source_version}",
        )
    except (PermissionError, ValueError):
        session.rollback()
        return _temporary_error(
            503,
            "knowledge_indexing_unavailable",
            "The document could not be queued for indexing.",
        )
    return JSONResponse(
        status_code=201,
        content=jsonable_encoder({
            "document": safe_document_summary(session, document),
            "job": safe_job_summary(job),
        }),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/knowledge", response_model=KnowledgeDocumentListResponse)
def list_knowledge_documents(
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rollout, _settings = _web_rollout(auth, user)
    if not rollout.knowledge_library.enabled:
        return _knowledge_library_unavailable()
    documents = list_owned_knowledge_documents(
        session, owner_user_id=int(user.id)
    )
    return JSONResponse(
        content=jsonable_encoder({
            "items": [
                safe_document_summary(session, document)
                for document in documents
            ]
        }),
        headers={"Cache-Control": "no-store"},
    )


@router.get(
    "/knowledge/{document_id}",
    response_model=KnowledgeDocumentResultResponse,
)
def get_knowledge_document_status(
    document_id: UUID,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rollout, _settings = _web_rollout(auth, user)
    if not rollout.knowledge_library.enabled:
        return _knowledge_library_unavailable()
    try:
        document = owned_knowledge_document(
            session,
            owner_user_id=int(user.id),
            document_id=str(document_id),
        )
    except PermissionError:
        return _temporary_error(
            404, "knowledge_document_not_found", "Document not found."
        )
    job = latest_owned_knowledge_job(
        session, owner_user_id=int(user.id), document_id=document.id
    )
    return JSONResponse(
        content=jsonable_encoder({
            "document": safe_document_summary(session, document),
            "job": safe_job_summary(job),
        }),
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/knowledge/{document_id}", status_code=204)
def delete_knowledge_document(
    document_id: UUID,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rollout, _settings = _web_rollout(auth, user)
    if not rollout.knowledge_library.enabled:
        return _knowledge_library_unavailable()
    try:
        delete_owned_knowledge_document(
            session,
            owner_user_id=int(user.id),
            document_id=str(document_id),
        )
    except PermissionError:
        return _temporary_error(
            404, "knowledge_document_not_found", "Document not found."
        )
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.post(
    "/knowledge/{document_id}/reindex",
    response_model=KnowledgeDocumentResultResponse,
)
def reindex_knowledge_document(
    document_id: UUID,
    payload: KnowledgeReindexRequest,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rollout, _settings = _web_rollout(auth, user)
    if not rollout.knowledge_library.enabled:
        return _knowledge_library_unavailable()
    try:
        job = reindex_owned_knowledge_document(
            session,
            owner_user_id=int(user.id),
            document_id=str(document_id),
            operation_id=str(payload.operation_id),
        )
        document = owned_knowledge_document(
            session,
            owner_user_id=int(user.id),
            document_id=str(document_id),
        )
    except PermissionError:
        return _temporary_error(
            404, "knowledge_document_not_found", "Document not found."
        )
    except ValueError:
        session.rollback()
        return _temporary_error(
            409,
            "knowledge_reindex_unavailable",
            "This document cannot be re-indexed.",
        )
    return JSONResponse(
        content=jsonable_encoder({
            "document": safe_document_summary(session, document),
            "job": safe_job_summary(job),
        }),
        headers={"Cache-Control": "no-store"},
    )


@router.get(
    "/knowledge/{document_id}/job",
    response_model=KnowledgeJobResultResponse,
)
def get_knowledge_job_status(
    document_id: UUID,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rollout, _settings = _web_rollout(auth, user)
    if not rollout.knowledge_library.enabled:
        return _knowledge_library_unavailable()
    try:
        document = owned_knowledge_document(
            session,
            owner_user_id=int(user.id),
            document_id=str(document_id),
        )
    except PermissionError:
        return _temporary_error(
            404, "knowledge_document_not_found", "Document not found."
        )
    job = latest_owned_knowledge_job(
        session, owner_user_id=int(user.id), document_id=document.id
    )
    return JSONResponse(
        content=jsonable_encoder({"job": safe_job_summary(job)}),
        headers={"Cache-Control": "no-store"},
    )


@router.delete(
    "/knowledge/{document_id}/job",
    response_model=KnowledgeJobResultResponse,
)
def cancel_knowledge_document_job(
    document_id: UUID,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rollout, _settings = _web_rollout(auth, user)
    if not rollout.knowledge_library.enabled:
        return _knowledge_library_unavailable()
    try:
        document = owned_knowledge_document(
            session,
            owner_user_id=int(user.id),
            document_id=str(document_id),
        )
    except PermissionError:
        return _temporary_error(
            404, "knowledge_document_not_found", "Document not found."
        )
    job = latest_owned_knowledge_job(
        session, owner_user_id=int(user.id), document_id=document.id
    )
    if job is not None and job.status in {"queued", "retrying", "running"}:
        cancel_knowledge_job(
            session,
            owner_user_id=int(user.id),
            job_id=int(job.id or 0),
        )
        document.status = "failed"
        document.updated_at = utc_now()
        session.add(document)
        session.commit()
        session.refresh(job)
    return JSONResponse(
        content=jsonable_encoder({"job": safe_job_summary(job)}),
        headers={"Cache-Control": "no-store"},
    )


@router.post("/uploads", status_code=201)
async def upload_document(
    file: UploadFile = File(...), session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    if not _env_enabled("WEB_ATTACHMENTS_ENABLED"):
        return _temporary_error(503, "web_attachments_disabled", "Temporary document attachments are unavailable.")
    _rate_limit(
        session,
        user_id=int(user.id),
        action="web_upload",
        limit=int(os.getenv("WEB_UPLOAD_RATE_LIMIT_PER_MINUTE", "10")),
    )
    session.commit()
    safe_name = sanitize_filename(file.filename)
    try:
        extension, media_type = validate_extension_and_mime(safe_name, file.content_type)
    except DocumentValidationError as exc:
        await file.close()
        return _temporary_error(exc.status_code, exc.code, exc.message)
    temp_path = ""
    binary_base64: str | None = None
    try:
        upload_limit = (
            image_max_file_bytes() if is_image_extension(extension)
            else max_file_bytes()
        )
        temp_path, size = await _save_temporary_upload(
            file, limit=upload_limit, suffix=extension,
        )
        if size <= 0:
            return _temporary_error(400, "empty_file", "The uploaded file is empty.")
        validate_content_signature(temp_path, extension)
        if is_image_extension(extension):
            binary_base64 = base64.b64encode(
                Path(temp_path).read_bytes()
            ).decode("ascii")
            extraction = None
        else:
            extraction = await asyncio.to_thread(
                extract_document, temp_path, extension
            )
    except DocumentValidationError as exc:
        return _temporary_error(exc.status_code, exc.code, exc.message)
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass

    ttl = upload_ttl_seconds()
    upload = EphemeralUpload(
        id=str(uuid4()),
        owner_user_id=int(user.id),
        name=safe_name,
        extension=extension,
        media_type=media_type,
        size_bytes=size,
        created_at=utc_iso(),
        expires_at=expiration_iso(ttl),
        chunks=extraction.chunks if extraction is not None else [],
        source_locators=(
            extraction.source_locators if extraction is not None else []
        ),
        warnings=extraction.warnings if extraction is not None else [],
        warning_codes=(
            extraction.warning_codes if extraction is not None else []
        ),
        binary_base64=binary_base64,
    )
    try:
        get_upload_store().put(upload)
    except UploadStoreUnavailable:
        return _temporary_error(
            503, "attachment_cache_unavailable", "Temporary attachments are unavailable. Please try again later."
        )
    return JSONResponse(
        status_code=201,
        content=upload.display_metadata(),
        headers={"Cache-Control": "no-store"},
    )


@router.post("/repositories", status_code=201)
async def upload_repository_snapshot(
    file: UploadFile = File(...),
    repository_id: UUID = Form(...),
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    _rollout, settings = _web_rollout(auth, user)
    if not settings.repository_upload_enabled:
        await file.close()
        return _temporary_error(
            503, "repository_upload_disabled",
            "Temporary repository uploads are unavailable.",
        )
    filename = str(file.filename or "")
    if not filename.casefold().endswith(".zip"):
        await file.close()
        return _temporary_error(
            415, "repository_archive_type",
            "Repository snapshots must use the ZIP archive format.",
        )
    _rate_limit(
        session, user_id=int(user.id), action="web_repository_upload",
        limit=settings.repository_rate_limit_per_minute,
    )
    session.commit()
    archive = await file.read(settings.repository_max_archive_bytes + 1)
    await file.close()
    if len(archive) > settings.repository_max_archive_bytes:
        return _temporary_error(
            413, "repository_archive_too_large",
            "The repository archive exceeds the configured size limit.",
        )
    try:
        snapshot, index, created = create_repository_snapshot(
            session,
            store=get_upload_store(),
            owner_user_id=int(user.id),
            repository_id=str(repository_id),
            archive=archive,
            display_name=filename,
            ttl_seconds=settings.repository_ttl_seconds,
            limits=ArchiveLimits(
                settings.repository_max_archive_bytes,
                settings.repository_max_uncompressed_bytes,
                settings.repository_max_files,
                settings.repository_max_compression_ratio,
            ),
        )
    except UnsafeRepositoryArchive as exc:
        return _temporary_error(
            422, str(exc), "The repository archive failed safety validation."
        )
    except UploadStoreUnavailable:
        return _temporary_error(
            503, "repository_cache_unavailable",
            "Temporary repositories are unavailable.",
        )
    metadata = snapshot.safe_metadata()
    metadata.update({
        "status": "ready",
        "languages": list(index.languages),
        "frameworks": list(index.frameworks),
        "symbol_count": len(index.symbols),
    })
    return JSONResponse(
        status_code=201 if created else 200,
        content=metadata,
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/repositories/{repository_id}", status_code=204)
def delete_repository_snapshot(
    repository_id: UUID,
    session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rollout, _settings = _web_rollout(auth, user)
    if not rollout.repository_chat.enabled:
        return _temporary_error(
            503,
            "repository_upload_disabled",
            "Temporary repository uploads are unavailable.",
        )
    row = session.exec(select(WebCodeRepository).where(
        WebCodeRepository.owner_user_id == int(user.id),
        WebCodeRepository.repository_id == str(repository_id),
        WebCodeRepository.status == "ready",
    )).first()
    if row is not None:
        invalidate_repository_index(
            session,
            owner_user_id=int(user.id),
            repository_id=str(repository_id),
        )
        session.commit()
    try:
        get_upload_store().delete_auxiliary(
            repository_store_key(int(user.id), str(repository_id))
        )
    except UploadStoreUnavailable:
        return _temporary_error(
            503, "repository_cache_unavailable",
            "Temporary repositories are unavailable.",
        )
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.delete("/uploads/{upload_id}", status_code=204)
def delete_upload(
    upload_id: str, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    try:
        store = get_upload_store()
        upload = store.get(upload_id)
        if upload is not None and upload.owner_user_id != int(user.id):
            return _temporary_error(404, "attachment_not_found", "Attachment not found.")
        if upload is not None:
            store.delete(upload_id)
    except UploadStoreUnavailable:
        return _temporary_error(
            503, "attachment_cache_unavailable", "Temporary attachments are unavailable. Please try again later."
        )
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.post("/uploads/text", status_code=201)
def upload_virtual_text(
    payload: VirtualTextUploadRequest, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    if not _env_enabled("WEB_LONG_INPUT_ENABLED"):
        return _temporary_error(503, "web_long_input_disabled", "Large pasted-text processing is unavailable.")
    maximum = _bounded_int_env("WEB_LONG_INPUT_MAX_CHARS", 64_000, 16_000, 64_000)
    if len(payload.text) > maximum:
        return _temporary_error(413, "long_input_too_large", f"Pasted text exceeds the {maximum:,}-character limit.")
    _rate_limit(
        session, user_id=int(user.id), action="web_text_upload",
        limit=int(os.getenv("WEB_UPLOAD_RATE_LIMIT_PER_MINUTE", "10")),
    )
    session.commit()
    upload_id = str(payload.upload_id)
    try:
        store = get_upload_store()
        existing = store.get(upload_id)
        if existing is not None:
            if existing.owner_user_id != int(user.id):
                return _temporary_error(404, "attachment_not_found", "Attachment not found.")
            return JSONResponse(status_code=200, content=existing.display_metadata(), headers={"Cache-Control": "no-store"})
        encoded_size = len(payload.text.encode("utf-8"))
        ttl = upload_ttl_seconds()
        upload = EphemeralUpload(
            id=upload_id, owner_user_id=int(user.id),
            name=f"Pasted text — {payload.operation.replace('_', ' ')}.txt",
            extension=".txt", media_type="text/plain", size_bytes=encoded_size,
            created_at=utc_iso(), expires_at=expiration_iso(ttl),
            chunks=chunk_virtual_text(payload.text),
            source_locators=["pasted text"], warnings=[], warning_codes=[],
            virtual_text_operation=payload.operation,
        )
        store.put(upload)
    except UploadStoreUnavailable:
        return _temporary_error(503, "attachment_cache_unavailable", "Temporary attachments are unavailable. Please try again later.")
    return JSONResponse(status_code=201, content=upload.display_metadata(), headers={"Cache-Control": "no-store"})


@router.post("/audio/transcribe")
async def transcribe_web_audio(
    request: Request, file: UploadFile = File(...), operation_id: UUID = Form(...),
    voice_turn_id: UUID = Form(...), language: str | None = Form(default=None),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    language = language or request.query_params.get("language")
    if selected_swico_tier(session, int(user.id)) == "free":
        await file.close()
        return _temporary_error(
            422, "swico_free_text_only",
            "Swico Free supports text only. Switch to Swico Lite, Swico, or Swico Pro for voice.",
        )
    if not _env_enabled("WEB_VOICE_RECORDING_ENABLED"):
        return _temporary_error(503, "web_voice_recording_disabled", "Voice dictation is unavailable.")
    if not _env_enabled("WEB_VOICE_BILLING_ENABLED"):
        return _temporary_error(503, "web_voice_billing_disabled", "Paid web voice is unavailable.")
    _rate_limit(
        session, user_id=int(user.id), action="web_stt",
        limit=int(os.getenv("WEB_STT_RATE_LIMIT_PER_MINUTE", "10")),
    )
    # Count every authenticated attempt, including requests rejected during
    # validation, without holding the rate-limit transaction during upload or
    # provider work.
    session.commit()
    billing_request_id = f"web-stt:{operation_id}"
    duplicate = session.exec(
        select(UsageCharge).where(
            UsageCharge.request_id == billing_request_id,
            UsageCharge.user_id == int(user.id),
        )
    ).first()
    if duplicate is not None:
        await file.close()
        return _temporary_error(
            409, "duplicate_voice_operation",
            "This transcription operation is already running or has already completed.",
        )
    content_type = str(file.content_type or "").split(";", 1)[0].strip().lower()
    extension = Path(sanitize_filename(file.filename or "recording.webm")).suffix.lower()
    allowed = {
        ".webm": {"audio/webm"},
        ".mp4": {"audio/mp4"},
        ".m4a": {"audio/mp4", "audio/m4a", "audio/x-m4a"},
    }
    if extension not in allowed or content_type not in allowed[extension]:
        await file.close()
        return _temporary_error(422, "unsupported_audio_type", "Recordings must be WebM/Opus, WebM, or MP4 audio.")
    temp_path = ""
    reserved = False
    billing_exempt = is_internal_test_user(auth, user)
    model = os.getenv("SARVAM_STT_MODEL", "saaras:v3") or "saaras:v3"
    try:
        temp_path, size = await _save_temporary_upload(
            file, limit=max_file_bytes(), suffix=extension,
        )
        if size <= 0:
            return _temporary_error(400, "empty_audio", "The recording is empty. Please record for a moment and try again.")
        duration, duration_method = estimate_audio_duration_details(temp_path, content_type, size)
        max_seconds = min(300, max(1, int(os.getenv("WEB_AUDIO_MAX_SECONDS", "300"))))
        if duration > max_seconds:
            return _temporary_error(413, "audio_too_long", "Recordings are limited to 300 seconds.")
        audio_milliseconds = int(
            (Decimal(str(duration)) * Decimal("1000")).to_integral_value(rounding=ROUND_CEILING)
        )
        price = stt_price(audio_milliseconds)
        if billing_exempt:
            create_billing_exempt_usage(
                session, request_id=billing_request_id, user_id=int(user.id),
                thread_id=None, provider="sarvam", model=model,
                pricing_snapshot_json=snapshot_json(price.snapshot), usage_kind="stt",
                voice_turn_id=str(voice_turn_id), audio_milliseconds=audio_milliseconds,
            )
        else:
            create_usage_reservation(
                session, request_id=billing_request_id, user_id=int(user.id),
                thread_id=None, provider="sarvam", model=model,
                reserved_micros=price.micros,
                pricing_snapshot_json=snapshot_json(price.snapshot), usage_kind="stt",
                voice_turn_id=str(voice_turn_id), audio_milliseconds=audio_milliseconds,
            )
        session.commit()
        reserved = True
        enforce_provider_budget(session, "sarvam", currency="INR")
        started = time.perf_counter()
        stt_provider = SarvamProvider()
        transcript = await asyncio.to_thread(
            transcribe_audio_file,
            stt_provider,
            temp_path,
            language,
            content_type=content_type,
            filename=f"recording{extension}",
        )
        if billing_exempt:
            charge = settle_billing_exempt_usage(
                session, request_id=billing_request_id,
                provider_cost_amount=price.amount, provider_cost_currency=price.currency,
                provider_cost_micros=price.micros, input_tokens=0,
                cached_input_tokens=0, output_tokens=0, usage_source="actual",
                pricing_snapshot_json=snapshot_json(price.snapshot), usage_kind="stt",
                voice_turn_id=str(voice_turn_id), audio_milliseconds=audio_milliseconds,
                provider="sarvam", model=model,
            )
        else:
            charge = settle_usage_reservation(
                session, request_id=billing_request_id,
                provider_cost_amount=price.amount, provider_cost_currency=price.currency,
                provider_cost_micros=price.micros, input_tokens=0,
                cached_input_tokens=0, output_tokens=0, usage_source="actual",
                pricing_snapshot_json=snapshot_json(price.snapshot), usage_kind="stt",
                voice_turn_id=str(voice_turn_id), audio_milliseconds=audio_milliseconds,
                provider="sarvam", model=model,
            )
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text="", provider="sarvam", model=model, route="sarvam_stt",
                reason="web_voice_dictation", language=normalize_audio_language(language) or "auto",
                intent="stt", audio_seconds=float(Decimal(audio_milliseconds) / Decimal("1000")),
                characters=len(transcript), estimated_cost_amount=price.amount,
                estimated_cost_currency="INR",
            ),
            user_id=int(user.id), request_id=billing_request_id,
            latency_ms=int(round((time.perf_counter() - started) * 1000)),
            metadata={
                "file_size": size,
                "content_type": content_type,
                "provider_content_type": normalize_stt_upload_mime_type(f"recording{extension}", content_type),
                "duration_estimation_method": duration_method,
                "client_source": "web_dictation",
                "voice_turn_id": str(voice_turn_id),
            },
        )
        session.commit()
    except DocumentValidationError as exc:
        return _temporary_error(exc.status_code, exc.code, exc.message)
    except InsufficientCreditError as exc:
        session.rollback()
        return JSONResponse(status_code=402, content={"error": {
            "code": "insufficient_voice_credit",
            "message": "Not enough Voice credits to transcribe this recording.",
            "available_micros": exc.available_micros,
            "estimated_required_micros": exc.estimated_required_micros,
            "credit_bucket": "voice",
        }}, headers={"Cache-Control": "no-store"})
    except UsageLimitReachedError as exc:
        session.rollback()
        return JSONResponse(status_code=402, content={"error": {
            "code": "usage_limit_reached", "message": str(exc),
            "current_usage_micros": exc.current_usage_micros,
            "configured_limit_micros": exc.configured_limit_micros,
            "remaining_micros": exc.remaining_micros, "reset_at": exc.reset_at,
        }}, headers={"Cache-Control": "no-store"})
    except IntegrityError:
        session.rollback()
        return _temporary_error(
            409, "duplicate_voice_operation",
            "This transcription operation is already running or has already completed.",
        )
    except BaseException as exc:
        session.rollback()
        if reserved:
            try:
                if billing_exempt:
                    release_billing_exempt_usage(session, billing_request_id)
                else:
                    release_usage_reservation(session, billing_request_id)
                session.commit()
            except Exception:
                session.rollback()
                logger.exception("web_stt_reservation_release_failed", extra={"request_id": billing_request_id})
        if isinstance(exc, HTTPException):
            return _temporary_error(exc.status_code, "stt_provider_failed", "The recording could not be transcribed.")
        if isinstance(exc, Exception):
            logger.exception("web_stt_failed", extra={"request_id": billing_request_id})
            return _temporary_error(500, "stt_failed", "The recording could not be transcribed.")
        raise
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass

    wallets = get_wallet_summaries(
        session, int(user.id), swico_tier=selected_swico_tier(session, int(user.id)),
        billing_exempt=billing_exempt,
    )
    return JSONResponse(
        content=jsonable_encoder({
            "transcript": transcript,
            "detected_language": (
                stt_provider.last_stt_detected_language
                or normalize_audio_language(language)
                or "auto"
            ),
            "duration_seconds": float(Decimal(audio_milliseconds) / Decimal("1000")),
            "duration_milliseconds": audio_milliseconds,
            "voice_turn_id": str(voice_turn_id),
            "stt_charge": {
                "charged_micros": int(charge.debited_micros),
                "voice_credits": ai_credits(int(charge.debited_micros)),
            },
            "wallet": wallets["chat"],
            "wallets": wallets,
        }),
        headers={"Cache-Control": "no-store"},
    )


@router.post("/audio/synthesize")
async def synthesize_web_audio(
    payload: WebTTSRequest, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    if selected_swico_tier(session, int(user.id)) == "free":
        return _temporary_error(
            422, "swico_free_text_only",
            "Swico Free supports text only. Switch to Swico Lite, Swico, or Swico Pro for voice.",
        )
    if not _env_enabled("WEB_VOICE_REPLY_ENABLED"):
        return _temporary_error(503, "web_voice_reply_disabled", "Voice replies are unavailable.")
    if not _env_enabled("WEB_VOICE_BILLING_ENABLED"):
        return _temporary_error(503, "web_voice_billing_disabled", "Paid web voice is unavailable.")
    _rate_limit(
        session, user_id=int(user.id), action="web_tts",
        limit=int(os.getenv("WEB_TTS_RATE_LIMIT_PER_MINUTE", "10")),
    )
    session.commit()
    billing_request_id = f"web-tts:{payload.operation_id}"
    if session.exec(select(UsageCharge).where(
        UsageCharge.request_id == billing_request_id,
        UsageCharge.user_id == int(user.id),
    )).first() is not None:
        return _temporary_error(
            409, "duplicate_voice_operation",
            "This voice reply operation is already running or has already completed; its audio is not stored.",
        )
    message = session.exec(select(WebChatMessage).where(
        WebChatMessage.id == payload.message_id,
        WebChatMessage.user_id == int(user.id),
        WebChatMessage.role == "assistant",
        WebChatMessage.status == "complete",
    )).first()
    if message is None:
        return _temporary_error(404, "assistant_message_not_found", "Assistant message not found.")
    try:
        metadata = json.loads(message.metadata_json or "{}")
    except (TypeError, ValueError):
        metadata = {}
    expected_voice_turn_id = (
        metadata.get("voice_turn_id")
        if isinstance(metadata, dict) and metadata.get("input_mode") != "text"
        else message.request_id
    )
    try:
        expected_voice_turn_id = str(UUID(str(expected_voice_turn_id)))
    except ValueError:
        expected_voice_turn_id = ""
    if not isinstance(metadata, dict) or expected_voice_turn_id != str(payload.voice_turn_id):
        return _temporary_error(404, "assistant_message_not_found", "Assistant message not found.")
    text_content = str(message.content or "")
    try:
        max_characters = max(1, int(os.getenv("WEB_TTS_MAX_CHARACTERS", "5000")))
    except ValueError:
        max_characters = 5000
    if len(text_content) > max_characters:
        return _temporary_error(
            422, "voice_reply_too_long",
            f"This reply is too long to play as voice (maximum {max_characters} characters).",
        )
    reply_language = metadata.get("reply_language")
    if reply_language not in {"en", "ta"}:
        reply_language = _resolved_reply_language(user)
    target_language_code = normalize_sarvam_tts_language_code(reply_language)
    model = normalize_sarvam_tts_model(os.getenv("SARVAM_TTS_MODEL"), premium=False)
    voice = resolve_sarvam_tts_voice(target_language_code)
    speaker = str(voice["speaker"])
    price = tts_price(len(text_content), model)
    billing_exempt = is_internal_test_user(auth, user)
    reserved = False
    try:
        if billing_exempt:
            create_billing_exempt_usage(
                session, request_id=billing_request_id, user_id=int(user.id),
                thread_id=message.thread_id, provider="sarvam", model=model,
                pricing_snapshot_json=snapshot_json(price.snapshot), usage_kind="tts",
                voice_turn_id=str(payload.voice_turn_id), characters=len(text_content),
                assistant_message_id=message.id,
            )
        else:
            create_usage_reservation(
                session, request_id=billing_request_id, user_id=int(user.id),
                thread_id=message.thread_id, provider="sarvam", model=model,
                reserved_micros=price.micros,
                pricing_snapshot_json=snapshot_json(price.snapshot), usage_kind="tts",
                voice_turn_id=str(payload.voice_turn_id), characters=len(text_content),
                assistant_message_id=message.id,
            )
        session.commit()
        reserved = True
        enforce_provider_budget(session, "sarvam", currency="INR")
        started = time.perf_counter()
        audio_base64 = await asyncio.to_thread(
            SarvamProvider().tts, text_content,
            target_language_code=target_language_code, speaker=speaker, premium=False,
        )
        try:
            decoded = base64.b64decode(audio_base64, validate=True)
        except Exception as exc:
            raise HTTPException(502, "TTS provider returned invalid audio.") from exc
        if not decoded:
            raise HTTPException(502, "TTS provider returned empty audio.")
        mime_type = (
            "audio/mpeg" if decoded.startswith((b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"))
            else "audio/ogg" if decoded.startswith(b"OggS")
            else "audio/wav"
        )
        if billing_exempt:
            charge = settle_billing_exempt_usage(
                session, request_id=billing_request_id,
                provider_cost_amount=price.amount, provider_cost_currency=price.currency,
                provider_cost_micros=price.micros, input_tokens=0,
                cached_input_tokens=0, output_tokens=0, usage_source="actual",
                pricing_snapshot_json=snapshot_json(price.snapshot), usage_kind="tts",
                voice_turn_id=str(payload.voice_turn_id), characters=len(text_content),
                assistant_message_id=message.id, provider="sarvam", model=model,
            )
        else:
            charge = settle_usage_reservation(
                session, request_id=billing_request_id,
                provider_cost_amount=price.amount, provider_cost_currency=price.currency,
                provider_cost_micros=price.micros, input_tokens=0,
                cached_input_tokens=0, output_tokens=0, usage_source="actual",
                pricing_snapshot_json=snapshot_json(price.snapshot), usage_kind="tts",
                voice_turn_id=str(payload.voice_turn_id), characters=len(text_content),
                assistant_message_id=message.id, provider="sarvam", model=model,
            )
        record_ai_usage_event(
            session,
            AIProviderResponse(
                text="", provider="sarvam", model=model, route="sarvam_tts",
                reason="web_voice_reply", language=target_language_code, intent="tts",
                characters=len(text_content), estimated_cost_amount=price.amount,
                estimated_cost_currency="INR",
            ),
            user_id=int(user.id), request_id=billing_request_id,
            latency_ms=int(round((time.perf_counter() - started) * 1000)),
            metadata={
                "character_count": len(text_content), "speaker": speaker,
                "target_language_code": target_language_code, "model": model,
                "voice_turn_id": str(payload.voice_turn_id),
            },
        )
        session.commit()
    except InsufficientCreditError as exc:
        session.rollback()
        return JSONResponse(status_code=402, content={"error": {
            "code": "insufficient_voice_credit",
            "message": "Not enough Voice credits to play this reply.",
            "available_micros": exc.available_micros,
            "estimated_required_micros": exc.estimated_required_micros,
            "credit_bucket": "voice",
        }}, headers={"Cache-Control": "no-store"})
    except UsageLimitReachedError as exc:
        session.rollback()
        return JSONResponse(status_code=402, content={"error": {
            "code": "usage_limit_reached", "message": str(exc),
            "current_usage_micros": exc.current_usage_micros,
            "configured_limit_micros": exc.configured_limit_micros,
            "remaining_micros": exc.remaining_micros, "reset_at": exc.reset_at,
        }}, headers={"Cache-Control": "no-store"})
    except IntegrityError:
        session.rollback()
        return _temporary_error(
            409, "duplicate_voice_operation",
            "This voice reply operation is already running or has already completed; its audio is not stored.",
        )
    except BaseException as exc:
        session.rollback()
        if reserved:
            try:
                if billing_exempt:
                    release_billing_exempt_usage(session, billing_request_id)
                else:
                    release_usage_reservation(session, billing_request_id)
                session.commit()
            except Exception:
                session.rollback()
                logger.exception("web_tts_reservation_release_failed", extra={"request_id": billing_request_id})
        if isinstance(exc, HTTPException):
            return _temporary_error(exc.status_code, "tts_provider_failed", "This voice reply could not be generated.")
        if isinstance(exc, Exception):
            logger.exception("web_tts_failed", extra={"request_id": billing_request_id})
            return _temporary_error(500, "tts_failed", "This voice reply could not be generated.")
        raise
    wallets = get_wallet_summaries(
        session, int(user.id), swico_tier=selected_swico_tier(session, int(user.id)),
        billing_exempt=billing_exempt,
    )
    return JSONResponse(content=jsonable_encoder({
        "audio_base64": audio_base64, "mime_type": mime_type,
        "speaker": speaker, "target_language_code": target_language_code,
        "model": model, "character_count": len(text_content),
        "charged_micros": int(charge.debited_micros),
        "voice_credits": ai_credits(int(charge.debited_micros)),
        "wallet": wallets["chat"],
        "wallets": wallets,
    }), headers={"Cache-Control": "no-store"})


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


@router.post("/chat/stream")
async def chat_stream(
    payload: WebChatRequest,
    request: Request,
    auth: AuthUser = Depends(get_current_user),
):
    inline_limit = 16_000
    if _env_enabled("WEB_LONG_INPUT_ENABLED"):
        inline_limit = _bounded_int_env(
            "WEB_LONG_INPUT_INLINE_THRESHOLD_CHARS", 12_000, 1_000, 16_000
        )
    if len(payload.message) > inline_limit:
        return _temporary_error(
            422, "long_input_requires_ingestion",
            "Large pasted text must be ingested as a temporary attachment before chat generation.",
        )
    with SessionLocal() as rate_session:
        user = get_owned_user(rate_session, auth)
        user_id = int(user.id)
        resolved_reply_language = _resolved_reply_language(user)
        billing_exempt = is_internal_test_user(auth, user)
        free_eligible = swico_free_eligible(
            user_id, internal_account=billing_exempt,
        )
        if selected_swico_tier(rate_session, user_id) == "free" and not free_eligible:
            return _temporary_error(
                422, "tier_unavailable",
                "Swico Free is not available for this account yet.",
            )
        rollout_decision, request_triag_settings = _web_rollout(auth, user)
        _rate_limit(rate_session, user_id=user_id, action="web_chat", limit=int(os.getenv("WEB_CHAT_RATE_LIMIT_PER_MINUTE", "12")))
        rate_session.commit()
    try:
        prepared = await asyncio.to_thread(
            prepare_web_turn, user_id=user_id, message=payload.message,
            request_id=str(payload.request_id), thread_id=str(payload.thread_id) if payload.thread_id else None,
            reply_language=resolved_reply_language,
            attachment_ids=[str(value) for value in payload.attachment_ids],
            repository_id=(
                str(payload.repository_id) if payload.repository_id else None
            ),
            billing_exempt=billing_exempt,
            input_mode=payload.input_mode,
            voice_turn_id=str(payload.voice_turn_id) if payload.voice_turn_id else None,
            continue_message_id=str(payload.continue_message_id) if payload.continue_message_id else None,
            edit_message_id=str(payload.edit_message_id) if payload.edit_message_id else None,
            regenerate_message_id=(
                str(payload.regenerate_message_id)
                if payload.regenerate_message_id else None
            ),
            billing_credit_bucket="chat",
            swico_free_eligible=free_eligible,
            rollout_decision=rollout_decision,
            triag_settings=request_triag_settings,
        )
    except InsufficientCreditError as exc:
        return JSONResponse(status_code=402, content={"error": {
            "code": "insufficient_credit", "message": "Add AI credit to continue.",
            "available_micros": exc.available_micros,
            "estimated_required_micros": exc.estimated_required_micros,
            "credit_bucket": "chat",
        }}, headers={"Cache-Control": "no-store"})
    except UsageLimitReachedError as exc:
        return JSONResponse(status_code=402, content={"error": {
            "code": "usage_limit_reached",
            "message": str(exc),
            "current_usage_micros": exc.current_usage_micros,
            "configured_limit_micros": exc.configured_limit_micros,
            "remaining_micros": exc.remaining_micros,
            "reset_at": exc.reset_at,
            "credit_bucket": "chat",
        }}, headers={"Cache-Control": "no-store"})
    except LookupError:
        raise HTTPException(404, "Thread not found")
    except DuplicateRequestInProgress as exc:
        raise HTTPException(409, str(exc))
    except PaymentValidationError:
        return _temporary_error(
            409, "request_id_bucket_conflict",
            "This request identifier was already used for another billing mode.",
        )
    except AttachmentRequestError as exc:
        return _temporary_error(exc.status_code, exc.code, exc.message)
    except EditRequestError as exc:
        return _temporary_error(exc.status_code, exc.code, exc.message)
    except PromptBudgetExceeded as exc:
        return _temporary_error(exc.status_code, exc.code, str(exc))
    except (SwicoTierUnavailableError, SwicoTierConfigurationError):
        return JSONResponse(status_code=503, content={"error": {
            "code": "swico_tier_unavailable",
            "message": "The selected Swico mode is temporarily unavailable. Please try again shortly.",
        }})

    if prepared.route.provider == "swico_free":
        try:
            _enforce_swico_free_limits(user_id)
        except SwicoFreeLimitError as exc:
            try:
                _release_swico_free_request(prepared.request_id)
            except Exception:
                logger.exception(
                    "swico_free_limit_release_failed",
                    extra={"request_id": prepared.request_id},
                )
            return _temporary_error(
                429, exc.code, str(exc), headers={"Retry-After": "60"},
            )

    cancellation = GenerationCancellation()
    prepared.ai_request.metadata["cancellation_signal"] = cancellation
    record_web_turn_lifecycle(prepared, "reserved")

    async def events():
        queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        started_at = time.monotonic()
        heartbeat_seconds = _bounded_float_env(
            "WEB_SSE_HEARTBEAT_SECONDS", 10.0, 0.01, 300.0
        )
        last_event_at = loop.time()
        visible_character_count = 0
        heartbeat_count = 0
        outcome = "cancelled"
        terminal_exception_class: str | None = None
        terminal_provider_attempts = 0
        terminal_retry_at: str | None = None
        ownership = {"observed": False, "generator_closed": False}

        def delta(value: str) -> None:
            loop.call_soon_threadsafe(
                queue.put_nowait, ("delta", value)
            )

        def status(phase: str) -> None:
            loop.call_soon_threadsafe(
                queue.put_nowait, ("status", phase)
            )

        def progress(character_count: int) -> None:
            loop.call_soon_threadsafe(
                queue.put_nowait, ("progress", str(max(0, character_count)))
            )

        task: asyncio.Task[Any] | None = None

        def unregister(done_task: asyncio.Task[Any]) -> None:
            with _active_generations_lock:
                _active_generations.pop(prepared.request_id, None)
                _pending_generation_cancellations.pop(
                    prepared.request_id, None
                )
            if not ownership["generator_closed"] or ownership["observed"]:
                return
            ownership["observed"] = True
            try:
                abandoned_error = done_task.exception()
            except asyncio.CancelledError:
                abandoned_error = None
            if abandoned_error is not None:
                logger.error(
                    "web_chat_abandoned_worker_failed",
                    extra={
                        "event": "web_chat_abandoned_worker_failed",
                        "request_id": prepared.request_id,
                        "exception_class": type(abandoned_error).__name__,
                    },
                )

        try:
            with _active_generations_lock:
                _active_generations[prepared.request_id] = (
                    user_id, cancellation,
                )
                pending_owner = _pending_generation_cancellations.pop(
                    prepared.request_id, None
                )
            if pending_owner == user_id:
                cancellation.cancel()
            task = asyncio.create_task(asyncio.to_thread(
                execute_web_turn,
                prepared,
                on_delta=delta,
                on_status=status,
                on_progress=progress,
            ))
            task.add_done_callback(unregister)
            yield _sse("thread", {
                "thread_id": prepared.thread_id,
                "continuation_render_prefix": (
                    prepared.continuation_render_prefix
                ),
                "continuation_parent_message_id": (
                    prepared.continuation_parent_message_id
                ),
                "continuation_root_message_id": (
                    prepared.continuation_root_message_id
                ),
                "continuation_segment_index": (
                    prepared.continuation_segment_index
                ),
                "continuation_rewind_characters": (
                    prepared.continuation_rewind_characters
                ),
            })
            yield _sse("status", {"phase": "routing"})
            if prepared.reserved_micros:
                yield _sse("status", {"phase": "reserved", "reserved_micros": prepared.reserved_micros})
            while not task.done():
                try:
                    remaining = max(
                        0.01,
                        min(0.15, heartbeat_seconds - (loop.time() - last_event_at)),
                    )
                    event_name, value = await asyncio.wait_for(
                        queue.get(), timeout=remaining
                    )
                    if event_name == "status":
                        yield _sse("status", {"phase": value})
                    elif event_name == "progress":
                        yield _sse("progress", {
                            "phase": "generating",
                            "buffered_character_count": int(value),
                        })
                    else:
                        visible_character_count += len(value)
                        yield _sse("delta", {"text": value})
                    last_event_at = loop.time()
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        outcome = "client_disconnected"
                        cancellation.cancel(reason="client_disconnected")
                        record_web_turn_pre_generation_abort(
                            prepared, reason="ClientDisconnected",
                        )
                        yield _sse("error", {
                            "code": "client_disconnected",
                            "message": "The browser connection closed before the response finished.",
                        })
                        return
                    if loop.time() - last_event_at >= heartbeat_seconds:
                        yield ": keep-alive\n\n"
                        heartbeat_count += 1
                        last_event_at = loop.time()
                    continue
            # Provider callbacks use call_soon_threadsafe.  The worker can reach its
            # terminal state before the event loop has run the final scheduled queue
            # callback, so give those callbacks one turn before draining the queue.
            await asyncio.sleep(0)
            while not queue.empty():
                event_name, value = queue.get_nowait()
                if event_name == "status":
                    yield _sse("status", {"phase": value})
                elif event_name == "progress":
                    yield _sse("progress", {
                        "phase": "generating",
                        "buffered_character_count": int(value),
                    })
                else:
                    visible_character_count += len(value)
                    yield _sse("delta", {"text": value})
                last_event_at = loop.time()
            try:
                completed = await task
            finally:
                ownership["observed"] = True
            response = completed.response
            terminal_provider_attempts = int(
                response.raw.get("provider_attempts") or 0
            )
            if completed.message.sources:
                yield _sse(
                    "sources",
                    {"sources": list(completed.message.sources)},
                )
            if completed.message.quality:
                yield _sse("quality", completed.message.quality)
            yield _sse("usage", {
                "tier": completed.message.swico_tier,
                "tier_label": (
                    SWICO_TIER_LABELS[completed.message.swico_tier]
                    if completed.message.swico_tier in SWICO_TIER_IDS else "Swico"
                ),
                "input_tokens": response.input_tokens, "output_tokens": response.output_tokens,
                "usage_source": completed.message.usage_source,
                "charged_micros": completed.message.charge_micros,
            })
            yield _sse("wallet", completed.wallet)
            yield _sse("done", {
                "message_id": completed.message.id, "thread_id": completed.thread_id,
                "cancelled": completed.message.status == "cancelled",
                "input_mode": prepared.input_mode,
                "voice_turn_id": (
                    prepared.voice_turn_id
                    or prepared.request_id
                    if prepared.input_mode == "text"
                    else prepared.voice_turn_id
                ),
                "reply_language": prepared.reply_language,
                "billing_credit_bucket": prepared.billing_credit_bucket,
                "finish_reason": str(response.raw.get("finish_reason") or "unknown"),
                "truncated": bool(response.raw.get("truncated")),
                "can_continue": bool(response.raw.get("truncated")) and completed.message.status == "complete",
                "continuation_render_prefix": (
                    prepared.continuation_render_prefix
                ),
                "continuation_parent_message_id": (
                    prepared.continuation_parent_message_id
                ),
                "continuation_root_message_id": (
                    prepared.continuation_root_message_id
                ),
                "continuation_segment_index": (
                    prepared.continuation_segment_index
                ),
                "continuation_rewind_characters": (
                    prepared.continuation_rewind_characters
                ),
                "parent_can_continue": (
                    False
                    if prepared.continuation_parent_message_id else None
                ),
                "completion_status": str(response.raw.get("completion_status") or "unknown"),
                "provenance": (
                    response.raw.get("provenance")
                    if _env_enabled("WEB_RESPONSE_PROVENANCE_ENABLED") else []
                ),
                "memory_updated": bool(response.raw.get("memory_updated")),
                "sources": list(completed.message.sources),
                "quality": completed.message.quality,
            })
            outcome = "done"
        except asyncio.CancelledError:
            outcome = "client_disconnected"
            terminal_exception_class = "CancelledError"
            cancellation.cancel(reason="client_disconnected")
            record_web_turn_pre_generation_abort(
                prepared, reason="CancelledError",
            )
            # The cooperative worker owns settlement. Some provider consumption
            # may already have occurred before cancellation reaches the provider.
            raise
        except GeneratorExit:
            outcome = "client_disconnected"
            terminal_exception_class = "GeneratorExit"
            cancellation.cancel(reason="client_disconnected")
            record_web_turn_pre_generation_abort(
                prepared, reason="GeneratorExit",
            )
            raise
        except GenerationCancelled as exc:
            outcome = "cancelled"
            terminal_exception_class = type(exc).__name__
            record_web_turn_pre_generation_abort(
                prepared, reason=type(exc).__name__,
            )
            with SessionLocal() as session:
                yield _sse(
                    "wallet",
                    get_wallet_summary(
                        session, user_id, swico_tier=prepared.swico_tier,
                        billing_exempt=prepared.billing_exempt,
                        credit_bucket=prepared.billing_credit_bucket,
                    ),
                )
            yield _sse("status", {"phase": "stopped"})
            yield _sse("done", {
                "message_id": None, "thread_id": prepared.thread_id, "cancelled": True,
                "code": "generation_cancelled",
                "input_mode": prepared.input_mode,
                "voice_turn_id": prepared.voice_turn_id,
                "reply_language": prepared.reply_language,
                "billing_credit_bucket": prepared.billing_credit_bucket,
            })
        except OpenAIBudgetExceededError as exc:
            outcome = "capacity_limited"
            terminal_exception_class = type(exc).__name__
            terminal_provider_attempts = 0
            terminal_retry_at = str(exc.metadata["reset_at"])
            record_web_turn_pre_generation_abort(
                prepared, reason=type(exc).__name__,
            )
            with SessionLocal() as session:
                yield _sse(
                    "wallet",
                    get_wallet_summary(
                        session,
                        user_id,
                        swico_tier=prepared.swico_tier,
                        billing_exempt=prepared.billing_exempt,
                        credit_bucket=prepared.billing_credit_bucket,
                    ),
                )
            yield _sse("error", {
                "code": OpenAIBudgetExceededError.code,
                "message": "Swico has reached today’s service capacity.",
                "retryable": True,
                "retry_at": terminal_retry_at,
            })
        except GenerationIncomplete as exc:
            outcome = "incomplete"
            terminal_exception_class = type(exc).__name__
            record_web_turn_pre_generation_abort(
                prepared, reason="generation_incomplete",
            )
            logger.warning(
                "web_chat_generation_incomplete",
                extra={"request_id": prepared.request_id},
            )
            yield _sse("error", {
                "code": "generation_incomplete",
                "message": (
                    "Swico reached its response limit before it could start "
                    "the answer. Please retry."
                ),
            })
        except ProviderSafetyRejected:
            outcome = "safety_rejected"
            terminal_exception_class = "ProviderSafetyRejected"
            record_web_turn_pre_generation_abort(
                prepared, reason="ProviderSafetyRejected",
            )
            yield _sse("error", {
                "code": "provider_safety_rejected",
                "message": (
                    "Swico can’t help with that request. I can help with "
                    "account recovery and defensive security instead."
                ),
                "retryable": False,
            })
        except ProviderStreamInterrupted as exc:
            outcome = "error"
            terminal_exception_class = type(exc).__name__
            terminal_provider_attempts = int(
                exc.metadata.get("provider_attempts") or 0
            )
            record_web_turn_pre_generation_abort(
                prepared, reason=type(exc).__name__,
            )
            logger.warning(
                "web_chat_stream_interrupted",
                extra={
                    "event": "web_chat_stream_interrupted",
                    "request_id": prepared.request_id,
                    "exception_class": type(exc).__name__,
                    "provider_attempts": terminal_provider_attempts,
                    "visible_character_count": visible_character_count,
                },
            )
            yield _sse("error", {
                "code": "stream_interrupted",
                "message": (
                    "The connection ended before Swico finished. Retry."
                ),
            })
        except SwicoFreeProviderError as exc:
            outcome = "capacity_limited" if exc.code == "swico_free_busy" else "error"
            terminal_exception_class = type(exc).__name__
            record_web_turn_pre_generation_abort(
                prepared, reason=exc.code,
            )
            yield _sse("error", {
                "code": exc.code,
                "message": (
                    "Swico Free is busy. Please try again shortly."
                    if exc.code == "swico_free_busy"
                    else "Swico Free reached its response-time limit. Please try again."
                    if exc.code == "swico_free_timeout"
                    else "Swico Free is temporarily unavailable. Please try again shortly."
                ),
                "retryable": True,
                "http_status": exc.status_code,
            })
        except Exception as exc:
            outcome = "error"
            terminal_exception_class = type(exc).__name__
            record_web_turn_pre_generation_abort(
                prepared, reason=type(exc).__name__,
            )
            logger.exception("web_chat_generation_failed", extra={"request_id": prepared.request_id})
            yield _sse("error", {"code": "generation_failed", "message": "Swico could not complete this request. Please retry."})
        finally:
            record_web_turn_lifecycle(prepared, "stream_terminal")
            ownership["generator_closed"] = True
            with _active_generations_lock:
                _active_generations.pop(prepared.request_id, None)
            if task is not None and task.done() and not ownership["observed"]:
                ownership["observed"] = True
                try:
                    abandoned_error = task.exception()
                except asyncio.CancelledError:
                    abandoned_error = None
                if abandoned_error is not None:
                    terminal_exception_class = (
                        terminal_exception_class
                        or type(abandoned_error).__name__
                    )
                    logger.error(
                        "web_chat_abandoned_worker_failed",
                        extra={
                            "event": "web_chat_abandoned_worker_failed",
                            "request_id": prepared.request_id,
                            "exception_class": type(abandoned_error).__name__,
                        },
                    )
            terminal_logger = (
                logger.warning if outcome == "capacity_limited" else logger.info
            )
            terminal_logger(
                "web_chat_stream_terminal",
                extra={
                    "event": "web_chat_stream_terminal",
                    "request_id": prepared.request_id,
                    "outcome": outcome,
                    "duration_ms": int(
                        (time.monotonic() - started_at) * 1000
                    ),
                    "visible_character_count": visible_character_count,
                    "exception_class": terminal_exception_class,
                    "provider_attempts": terminal_provider_attempts,
                    "heartbeat_count": heartbeat_count,
                    "retry_at": terminal_retry_at,
                },
            )

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/chat/requests/{request_id}/cancel")
async def cancel_chat_request(
    request_id: str, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    charge = session.exec(select(UsageCharge).where(
        UsageCharge.request_id == request_id, UsageCharge.user_id == user.id
    )).first()
    if charge is None:
        with _active_generations_lock:
            _pending_generation_cancellations[request_id] = int(user.id)
        return {"status": "cancelling", "request_id": request_id}
    queued = False
    with _active_generations_lock:
        active = _active_generations.get(request_id)
        if (
            active is None
            and charge.status in {"reserving", "reserved", "exempt_pending"}
        ):
            _pending_generation_cancellations[request_id] = int(user.id)
            queued = True
    if queued:
        return {"status": "cancelling", "request_id": request_id}
    if active and active[0] == int(user.id):
        active[1].cancel()
        deadline = asyncio.get_running_loop().time() + float(os.getenv("WEB_CANCELLATION_WAIT_SECONDS", "10"))
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.2)
            try:
                with SessionLocal() as check_session:
                    current = check_session.exec(select(UsageCharge).where(
                        UsageCharge.request_id == request_id
                    )).first()
                    if current and current.status in {
                        "released", "settled", "billing_exempt", "failed",
                    }:
                        assistant = check_session.exec(select(
                            WebChatMessage
                        ).where(
                            WebChatMessage.request_id == request_id,
                            WebChatMessage.user_id == user.id,
                            WebChatMessage.role == "assistant",
                        )).first()
                        stopped = (
                            current.status == "released"
                            or (
                                assistant is not None
                                and assistant.status == "cancelled"
                            )
                        )
                        return {
                            "status": "stopped" if stopped else "completed",
                            "request_id": request_id,
                        }
            except Exception:
                return {"status": "cancelling", "request_id": request_id}
        return {"status": "cancelling", "request_id": request_id}
    if active is None and charge.status in {
        "released", "settled", "billing_exempt", "failed",
    }:
        return {"status": "already_complete", "request_id": request_id}
    return {"status": charge.status, "request_id": request_id}


@router.get("/billing/wallet")
def wallet(session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    tier = selected_swico_tier(session, int(user.id))
    exempt = is_internal_test_user(auth, user)
    wallets = get_wallet_summaries(session, int(user.id), swico_tier=tier, billing_exempt=exempt)
    return {**wallets["chat"], "wallet": wallets["chat"], "wallets": wallets}


@router.get("/billing/estimate", response_model=TopupEstimateResponse)
def estimate_topup(
    gross_amount_paise: int = Query(..., gt=0),
    credit_bucket: str = Query("chat", pattern="^(chat|voice)$"),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    if is_internal_test_user(auth, user):
        raise HTTPException(403, {
            "code": "payments_unavailable",
            "message": "Payments are not available for this internal testing account.",
        })
    _rate_limit(session, user_id=int(user.id), action="payment_estimate", limit=30)
    try:
        amount = validate_topup_amount(gross_amount_paise)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    credited_amount_micros, _platform_share_paise = calculate_topup(amount)
    estimate = token_estimate(
        credited_amount_micros,
        tier=selected_swico_tier(session, int(user.id)),
    )
    return {
        "gross_amount_paise": amount,
        "credit_bucket": credit_bucket,
        "token_estimate": {
            "tier": estimate["tier"],
            "tier_label": estimate["tier_label"],
            "estimated_blended_tokens": estimate["estimated_blended_tokens"],
            "range_min_tokens": estimate["range_min_tokens"],
            "range_max_tokens": estimate["range_max_tokens"],
        } if credit_bucket == "chat" else None,
        "voice_estimate": _voice_credit_estimate(credited_amount_micros) if credit_bucket == "voice" else None,
    }


@router.get("/billing/ledger")
def ledger(
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rows = list_wallet_ledger(session, int(user.id), limit=limit, offset=offset)
    return {"items": [{
        "id": row.id, "entry_type": row.entry_type, "amount_micros": row.amount_micros,
        "balance_after_micros": row.balance_after_micros, "reference_type": row.reference_type,
        "reference_id": row.reference_id, "created_at": row.created_at,
        "credit_bucket": row.credit_bucket,
    } for row in rows]}


@router.get("/billing/payments")
def payments(
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    swico_tier = selected_swico_tier(session, int(user.id))
    rows = session.exec(select(PaymentOrder).where(PaymentOrder.user_id == user.id)
        .order_by(PaymentOrder.created_at.desc()).offset(offset).limit(limit)).all()
    order_ids = [str(row.id) for row in rows]
    payment_credit_refs: set[str] = set()
    if order_ids:
        credit_rows = session.exec(select(WalletLedger).where(
            WalletLedger.user_id == user.id,
            WalletLedger.entry_type == "payment_credit",
            WalletLedger.reference_type == "payment_order",
            WalletLedger.reference_id.in_(order_ids),
        )).all()
        payment_credit_refs = {str(row.reference_id) for row in credit_rows}
    payment_received_statuses = {"captured", "credited", "partially_refunded", "refunded"}
    return {"items": [{
        "id": row.id, "gross_amount_paise": row.gross_amount_paise,
        "credit_bucket": row.credit_bucket,
        "credited_amount_micros": row.credited_amount_micros,
        "platform_share_paise": row.platform_share_paise, "refunded_amount_paise": row.refunded_amount_paise,
        "credit_reversal_micros": (
            row.credited_amount_micros * row.refunded_amount_paise // row.gross_amount_paise
            if row.gross_amount_paise else 0
        ),
        "token_estimate": token_estimate(row.credited_amount_micros, tier=swico_tier) if row.credit_bucket == "chat" else None,
        "voice_estimate": _voice_credit_estimate(row.credited_amount_micros) if row.credit_bucket == "voice" else None,
        "reversal_token_estimate": token_estimate(
            row.credited_amount_micros * row.refunded_amount_paise // row.gross_amount_paise
            if row.gross_amount_paise else 0, tier=swico_tier
        ) if row.credit_bucket == "chat" else None,
        "status": row.status,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "paid_at": row.paid_at,
        "refunded_at": row.refunded_at,
        "payment_received": row.paid_at is not None or row.status in payment_received_statuses,
        "credit_applied": str(row.id) in payment_credit_refs,
    } for row in rows]}


def _payment_status_response(row: PaymentOrder) -> dict[str, Any]:
    return {
        "internal_order_id": row.id,
        "credit_bucket": row.credit_bucket,
        "gross_amount_paise": row.gross_amount_paise,
        "credited_amount_micros": row.credited_amount_micros,
        "platform_share_paise": row.platform_share_paise,
        "refunded_amount_paise": row.refunded_amount_paise,
        "status": row.status,
        "provider_payment_id": row.provider_payment_id,
        "created_at": row.created_at,
        "paid_at": row.paid_at,
        "refunded_at": row.refunded_at,
        "updated_at": row.updated_at,
    }


@router.get("/billing/payments/{internal_order_id}")
def payment_status(
    internal_order_id: str, session: Session = Depends(get_session),
    auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    row = session.exec(select(PaymentOrder).where(
        PaymentOrder.id == internal_order_id, PaymentOrder.user_id == user.id
    )).first()
    if row is None:
        raise HTTPException(404, "Payment order not found")
    return _payment_status_response(row)


@router.post("/billing/orders", status_code=201)
def create_order(payload: CreateOrderRequest, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    if is_internal_test_user(auth, user):
        raise HTTPException(403, {
            "code": "payments_unavailable",
            "message": "Payments are not available for this internal testing account.",
        })
    if not _checkout_enabled():
        raise HTTPException(503, {
            "code": "checkout_disabled",
            "message": "Adding credits is temporarily unavailable. Existing credits can still be used.",
        })
    _razorpay_mode()
    _rate_limit(session, user_id=int(user.id), action="payment_order", limit=6)
    try:
        gross_amount_paise = validate_topup_amount(payload.gross_amount_paise)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    digest = hashlib.sha256(f"{user.id}:{payload.idempotency_key}".encode()).hexdigest()[:26]
    receipt = f"sw_{digest}"[:40]
    existing = session.exec(select(PaymentOrder).where(PaymentOrder.receipt == receipt, PaymentOrder.user_id == user.id)).first()
    if existing and (existing.gross_amount_paise != gross_amount_paise or existing.credit_bucket != payload.credit_bucket):
        raise HTTPException(409, "Idempotency key was already used for another amount or credit bucket.")
    if existing and existing.provider_order_id:
        return _order_checkout_response(existing)
    credit_micros, platform_paise = calculate_topup(gross_amount_paise)
    order = existing or PaymentOrder(
        user_id=int(user.id), receipt=receipt, gross_amount_paise=gross_amount_paise,
        credit_bucket=payload.credit_bucket,
        credited_amount_micros=credit_micros, platform_share_paise=platform_paise,
    )
    session.add(order)
    session.commit()  # The durable internal order exists before the external call.
    try:
        provider_order = RazorpayClient().create_order(order.gross_amount_paise, order.receipt)
        if int(provider_order.get("amount", -1)) != order.gross_amount_paise or provider_order.get("currency") != "INR":
            raise PaymentValidationError("Razorpay returned mismatched order details.")
        order.provider_order_id = str(provider_order["id"])
        order.status = "created"
        order.updated_at = utc_now()
        session.add(order)
        session.commit()
        return _order_checkout_response(order)
    except Exception:
        order.status = "failed"
        order.updated_at = utc_now()
        session.add(order)
        session.commit()
        raise HTTPException(502, "Unable to create payment order.")


def _order_checkout_response(order: PaymentOrder) -> dict[str, Any]:
    return {
        "key_id": os.getenv("RAZORPAY_KEY_ID", "").strip(), "provider_order_id": order.provider_order_id,
        "amount": order.gross_amount_paise, "currency": "INR", "internal_order_id": order.id,
        "credited_amount_micros": order.credited_amount_micros,
        "platform_share_paise": order.platform_share_paise,
        "credit_bucket": order.credit_bucket,
    }


def _validate_captured_payment(order: PaymentOrder, payment: dict[str, Any], expected_payment_id: str | None = None) -> None:
    if expected_payment_id and str(payment.get("id") or "") != expected_payment_id:
        raise PaymentValidationError("Payment ID does not match.")
    if str(payment.get("order_id")) != str(order.provider_order_id):
        raise PaymentValidationError("Payment order does not match.")
    if int(payment.get("amount", -1)) != order.gross_amount_paise:
        raise PaymentValidationError("Payment amount does not match.")
    if payment.get("currency") != "INR":
        raise PaymentValidationError("Payment currency does not match.")
    if payment.get("status") != "captured" and payment.get("captured") is not True:
        raise PaymentValidationError("Payment capture is pending.")


@router.post("/billing/verify")
def verify_payment(payload: VerifyPaymentRequest, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    _rate_limit(session, user_id=int(user.id), action="payment_verify", limit=12)
    order = session.exec(select(PaymentOrder).where(PaymentOrder.id == payload.internal_order_id, PaymentOrder.user_id == user.id).with_for_update()).first()
    if order is None:
        raise HTTPException(404, "Payment order not found")
    if not order.provider_order_id or payload.razorpay_order_id != order.provider_order_id:
        raise HTTPException(400, "Payment order does not match.")
    if not verify_checkout_signature(order.provider_order_id, payload.razorpay_payment_id, payload.razorpay_signature):
        raise HTTPException(400, "Invalid payment signature.")
    try:
        payment = RazorpayClient().fetch_payment(payload.razorpay_payment_id)
        _validate_captured_payment(order, payment, payload.razorpay_payment_id)
    except PaymentValidationError as exc:
        if "pending" in str(exc).lower():
            order.status = "attempted"
            session.add(order)
            return {"status": "pending", "credited": False}
        raise HTTPException(400, str(exc))
    if order.provider_payment_id and order.provider_payment_id != payload.razorpay_payment_id:
        raise HTTPException(409, "Payment order is already linked to another payment.")
    order.provider_payment_id = payload.razorpay_payment_id
    order.status = "captured"
    credit_payment_once(session, order)
    return {
        "status": "credited",
        "credited": True,
        "wallet": get_wallet_summary(
            session, int(user.id),
            swico_tier=selected_swico_tier(session, int(user.id)),
        ),
        "wallets": get_wallet_summaries(
            session, int(user.id), swico_tier=selected_swico_tier(session, int(user.id)),
        ),
    }


def _entity(payload: dict[str, Any], name: str) -> dict[str, Any]:
    value = ((payload.get("payload") or {}).get(name) or {}).get("entity") or {}
    return value if isinstance(value, dict) else {}


@router.post("/billing/razorpay/webhook")
async def razorpay_webhook(request: Request):
    max_bytes = int(os.getenv("RAZORPAY_WEBHOOK_MAX_BYTES", "262144"))
    raw = await request.body()
    if len(raw) > max_bytes:
        raise HTTPException(413, "Webhook body is too large.")
    signature = request.headers.get("x-razorpay-signature", "")
    if not verify_webhook_signature(raw, signature):
        raise HTTPException(400, "Invalid webhook signature.")
    event_id = request.headers.get("x-razorpay-event-id", "").strip()
    if not event_id or len(event_id) > 160:
        raise HTTPException(400, "Missing webhook event ID.")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid webhook JSON.")
    event_type = str(payload.get("event") or "")
    payload_hash = hashlib.sha256(raw).hexdigest()
    with SessionLocal() as session:
        prior = session.exec(select(ProcessedWebhook).where(
            ProcessedWebhook.provider == "razorpay", ProcessedWebhook.event_id == event_id
        )).first()
        if prior:
            return {"ok": True, "duplicate": True}

        payment = _entity(payload, "payment")
        order_entity = _entity(payload, "order")
        refund = _entity(payload, "refund")
        if event_type in {"payment.captured", "order.paid"}:
            provider_order_id = str(payment.get("order_id") or order_entity.get("id") or "")
            order = session.exec(select(PaymentOrder).where(PaymentOrder.provider_order_id == provider_order_id).with_for_update()).first()
            if order is None:
                raise HTTPException(400, "Unknown payment order.")
            if payment:
                try:
                    _validate_captured_payment(order, payment, str(payment.get("id") or ""))
                except PaymentValidationError as exc:
                    raise HTTPException(400, str(exc)) from exc
                payment_id = str(payment.get("id") or "")
                if not payment_id:
                    raise HTTPException(400, "Missing payment ID.")
                if order.provider_payment_id and order.provider_payment_id != payment_id:
                    raise HTTPException(409, "Payment ID does not match.")
                order.provider_payment_id = payment_id
            else:
                if int(order_entity.get("amount_paid", -1)) != order.gross_amount_paise or order_entity.get("currency") != "INR" or order_entity.get("status") != "paid":
                    raise HTTPException(400, "Paid order details do not match.")
            order.status = "captured"
            credit_payment_once(session, order)
        elif event_type == "refund.processed":
            payment_id = str(refund.get("payment_id") or payment.get("id") or "")
            refund_id = str(refund.get("id") or "").strip()
            if not refund_id:
                raise HTTPException(400, "Missing refund ID.")
            order = session.exec(select(PaymentOrder).where(PaymentOrder.provider_payment_id == payment_id).with_for_update()).first()
            if order is None and payment.get("order_id"):
                order = session.exec(select(PaymentOrder).where(
                    PaymentOrder.provider_order_id == str(payment.get("order_id"))
                ).with_for_update()).first()
                if order is not None:
                    try:
                        _validate_captured_payment(order, payment)
                    except PaymentValidationError as exc:
                        raise HTTPException(400, str(exc)) from exc
                    if str(payment.get("id") or "") != payment_id:
                        raise HTTPException(400, "Refund payment ID does not match.")
                    order.provider_payment_id = payment_id
                    order.status = "captured"
                    credit_payment_once(session, order)
            if order is None:
                raise HTTPException(400, "Unknown refunded payment.")
            if refund.get("currency") not in {None, "INR"}:
                raise HTTPException(400, "Refund currency does not match.")
            amount = int(refund.get("amount", -1))
            if amount <= 0 or order.refunded_amount_paise + amount > order.gross_amount_paise:
                raise HTTPException(400, "Refund amount does not match.")
            try:
                order_metadata = json.loads(order.metadata_json or "{}")
            except (TypeError, ValueError):
                order_metadata = {}
            processed_refund_ids = set(order_metadata.get("processed_refund_ids") or [])
            if refund_id not in processed_refund_ids:
                reverse_credit_for_refund(session, order, order.refunded_amount_paise + amount)
                processed_refund_ids.add(refund_id)
                order_metadata["processed_refund_ids"] = sorted(processed_refund_ids)
                order.metadata_json = json.dumps(order_metadata, sort_keys=True, separators=(",", ":"))
                session.add(order)
        elif event_type == "refund.failed":
            pass  # Valid event is recorded without reversing user credit.
        else:
            pass  # Unknown valid events are acknowledged and deduplicated.
        session.add(ProcessedWebhook(
            provider="razorpay", event_id=event_id, event_type=event_type or "unknown",
            payload_sha256=payload_hash,
        ))
        session.commit()
    return {"ok": True, "duplicate": False}
