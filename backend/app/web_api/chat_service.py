from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal
import json
import logging
import os
from typing import Any, Callable, Literal

from sqlmodel import Session, select

from ..ai.prompts import build_provider_messages, serialize_provider_messages
from ..ai.providers.openai_provider import OpenAIProvider
from ..ai.providers.sarvam_provider import SarvamProvider
from ..ai.providers.base import GenerationCancelled
from ..ai.router import AIProviderRouter
from ..ai.types import AIProviderResponse, AIRequest, AIRoute
from ..billing.pricing import estimate_tokens, env_decimal, openai_reported_price, price_usage, reserve_price, snapshot_json
from ..billing.errors import PaymentValidationError
from ..billing.service import (
    create_billing_exempt_usage, create_usage_reservation, get_wallet_summary,
    normalize_credit_bucket,
    release_billing_exempt_usage, release_usage_reservation,
    settle_billing_exempt_usage, settle_usage_reservation,
)
from ..database import SessionLocal
from ..models import (
    UsageCharge, WebChatMessage, WebChatThread, WebConversationSummary,
    WebMemoryFact,
)
from ..profile_context import build_profile_prompt_context, profile_prompt_context_text
from ..time_utils import utc_now
from .attachment_context import FullDocumentConfirmationRequired, select_attachment_context
from .conversation_continuity import (
    SameThreadContinuityDecision,
    decide_same_thread_continuity,
    normalize_same_thread_context_mode,
)
from .upload_store import UploadStoreUnavailable, get_upload_store
from .usage_service import selected_swico_tier
from .turn_optimizer import (
    WebTurnOptimization, optimizer_enabled, select_context_turns, with_prompt_estimate,
)
from .request_coordinator import WebRequestCoordinator, WebRequestDecision
from .swico_brand import swico_brand_response
from .web_memory import needs_cross_thread_memory, retrieve_memory, write_turn_memory


logger = logging.getLogger(__name__)


class DuplicateRequestInProgress(RuntimeError):
    pass


class AttachmentRequestError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class EditRequestError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass
class PreparedWebTurn:
    request_id: str
    user_id: int
    thread_id: str
    ai_request: AIRequest
    route: AIRoute
    reserved_micros: int
    swico_tier: str
    input_mode: str = "text"
    voice_turn_id: str | None = None
    reply_language: str = "en"
    billing_exempt: bool = False
    existing_response: WebChatMessage | None = None
    provider_messages: list[dict[str, str]] | None = None
    optimization: WebTurnOptimization | None = None
    coordinator_decision: WebRequestDecision | None = None
    precomputed_response: AIProviderResponse | None = None
    continuity_decision: SameThreadContinuityDecision | None = None
    billing_credit_bucket: Literal["chat", "voice"] = "chat"


@dataclass
class CompletedWebTurn:
    thread_id: str
    message: WebChatMessage
    wallet: dict[str, int]
    response: AIProviderResponse


def deterministic_title(message: str) -> str:
    one_line = " ".join(str(message).split()).strip()
    return (one_line[:57].rstrip() + "…") if len(one_line) > 58 else (one_line or "New chat")


def _owned_thread(session: Session, thread_id: str, user_id: int) -> WebChatThread:
    thread = session.exec(
        select(WebChatThread).where(WebChatThread.id == thread_id, WebChatThread.user_id == user_id)
    ).first()
    if thread is None:
        raise LookupError("Thread not found")
    return thread


def _context(
    session: Session, thread_id: str, user_id: int, *, turn_limit: int = 2
) -> tuple[list[dict[str, str]], dict[str, str]]:
    row_limit = min(24, max(8, max(1, turn_limit) * 4))
    rows = list(session.exec(
        select(WebChatMessage).where(
            WebChatMessage.thread_id == thread_id,
            WebChatMessage.user_id == user_id,
            WebChatMessage.status == "complete",
            WebChatMessage.superseded_at.is_(None),
        ).order_by(WebChatMessage.created_at.desc(), WebChatMessage.role.asc()).limit(row_limit)
    ).all())
    previous_metadata: dict[str, str] = {}
    for row in rows:
        if row.role != "assistant":
            continue
        try:
            stored = json.loads(row.metadata_json or "{}")
        except (TypeError, ValueError):
            stored = {}
        if isinstance(stored, dict):
            previous_metadata = {
                key: str(stored.get(key) or "")[:80]
                for key in ("topic", "brand_subintent", "brand_profile_version")
                if stored.get(key)
            }
        break
    turns: list[dict[str, str]] = []
    pending: WebChatMessage | None = None
    for row in reversed(rows):
        if row.role == "user":
            pending = row
        elif row.role == "assistant" and pending is not None:
            if pending.request_id and row.request_id and pending.request_id != row.request_id:
                pending = None
                continue
            turns.append({"user": pending.content, "assistant": row.content})
            pending = None
    return turns[-max(1, turn_limit):], previous_metadata


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _max_provider_attempts() -> int:
    try:
        configured = os.getenv(
            "WEB_PROVIDER_CALLS_PER_TURN_MAX",
            os.getenv("WEB_MAX_PROVIDER_ATTEMPTS", "1"),
        )
        return min(2, max(1, int(str(configured).strip())))
    except Exception:
        return 1


def _cache_response(user_id: int, message: str, reply_language: str | None) -> AIProviderResponse | None:
    if not _env_bool("WEB_CACHE_BEFORE_BILLING_ENABLED", True):
        return None
    try:
        from ..global_qa_cache import (
            GLOBAL_QA_EMBEDDING_KIND, lookup_approved_global_cache,
            token_hash_embedding_for_global_cache,
        )

        vector, norm, kind = token_hash_embedding_for_global_cache(message)
        token_bundle = {
            "embedding": vector,
            "embedding_norm": norm,
            "embedding_kind": kind or GLOBAL_QA_EMBEDDING_KIND,
            "token_hash_embedding": vector,
            "token_hash_embedding_norm": norm,
            "token_hash_embedding_kind": kind or GLOBAL_QA_EMBEDDING_KIND,
            "real_embedding": [],
            "real_embedding_norm": 0.0,
            "real_embedding_kind": None,
        }
        with SessionLocal() as cache_session:
            hit = lookup_approved_global_cache(
                cache_session, message, reply_language, user_id=user_id,
                query_embedding=token_bundle,
            )
    except Exception:
        return None
    if not hit or not str(hit.get("answer") or "").strip():
        return None
    answer = str(hit["answer"]).strip()
    return AIProviderResponse(
        text=answer, provider="cache", model=None, route="global_knowledge_cache",
        reason="approved_global_cache_hit",
        language=str(hit.get("answer_language") or reply_language or "en"),
        intent="general", characters=len(answer),
        raw={
            "cache_hit": True,
            "cache_hit_source": hit.get("cache_hit_source") or "L3_global_qa",
            "provider_attempts": 0,
            "provider_calls_with_usage": 0,
            "fallback_attempted": False,
        },
    )


def _load_attachments(user_id: int, attachment_ids: list[str]) -> list[Any]:
    if not attachment_ids:
        return []
    try:
        configured_files = int(os.getenv("WEB_UPLOAD_MAX_FILES_PER_MESSAGE", "5"))
    except ValueError:
        configured_files = 5
    if len(attachment_ids) > min(5, max(1, configured_files)):
        raise AttachmentRequestError(
            "too_many_attachments", "Too many attachments were included in this message.", 422
        )
    try:
        store = get_upload_store()
        uploads = []
        for upload_id in attachment_ids:
            upload = store.get(upload_id)
            if upload is None:
                raise AttachmentRequestError(
                    "attachment_expired",
                    "An attachment has expired or is no longer available. Remove it and upload it again.",
                    410,
                )
            if upload.owner_user_id != user_id:
                raise AttachmentRequestError("attachment_not_found", "Attachment not found.", 404)
            uploads.append(upload)
    except UploadStoreUnavailable as exc:
        raise AttachmentRequestError(
            "attachment_cache_unavailable",
            "Temporary attachments are unavailable. Please try again later.",
            503,
        ) from exc
    try:
        configured_total = int(os.getenv("WEB_UPLOAD_MAX_TOTAL_BYTES", str(25 * 1024 * 1024)))
    except ValueError:
        configured_total = 25 * 1024 * 1024
    max_total = min(25 * 1024 * 1024, max(1, configured_total))
    if sum(upload.size_bytes for upload in uploads) > max_total:
        raise AttachmentRequestError(
            "attachment_total_too_large", "Attachments exceed the 25 MiB total limit.", 413
        )
    return uploads


def prepare_web_turn(
    *, user_id: int, message: str, request_id: str, thread_id: str | None,
    reply_language: str | None, attachment_ids: list[str] | None = None,
    billing_exempt: bool = False, input_mode: str = "text",
    voice_turn_id: str | None = None,
    continue_message_id: str | None = None,
    edit_message_id: str | None = None,
    billing_credit_bucket: Literal["chat", "voice"] = "chat",
) -> PreparedWebTurn:
    authoritative_bucket = normalize_credit_bucket(billing_credit_bucket)
    with SessionLocal() as session:
        swico_tier = selected_swico_tier(session, user_id)
        existing_charge = session.exec(
            select(UsageCharge).where(UsageCharge.request_id == request_id)
        ).first()
        if existing_charge is not None and existing_charge.credit_bucket != authoritative_bucket:
            raise PaymentValidationError("Request ID was already used for another credit bucket.")
        existing_assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == user_id,
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "assistant",
        )).first()
        if existing_assistant is not None:
            try:
                existing_metadata = json.loads(existing_assistant.metadata_json or "{}")
            except (TypeError, ValueError):
                existing_metadata = {}
            stored_bucket = (
                existing_charge.credit_bucket
                if existing_charge is not None
                else normalize_credit_bucket(
                    existing_metadata.get("billing_credit_bucket")
                    if isinstance(existing_metadata, dict) else "chat"
                )
            )
            if stored_bucket != authoritative_bucket:
                raise PaymentValidationError(
                    "Request ID was already used for another credit bucket."
                )
            thread = _owned_thread(session, existing_assistant.thread_id, user_id)
            dummy = AIRequest(user_id, message, reply_language, "text", request_id, {})
            route = AIRoute("blocked", None, "idempotent_replay", "already_complete", "en", "replay", 0)
            return PreparedWebTurn(
                request_id=request_id, user_id=user_id, thread_id=thread.id,
                ai_request=dummy, route=route, reserved_micros=0,
                swico_tier=swico_tier, input_mode=input_mode,
                voice_turn_id=voice_turn_id, reply_language=str(reply_language or "en"),
                billing_exempt=billing_exempt, existing_response=existing_assistant,
                billing_credit_bucket=stored_bucket,
            )

        existing_user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == user_id,
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "user",
        )).first()
        if existing_user_message is not None and existing_charge is not None and existing_charge.status != "released":
            raise DuplicateRequestInProgress("This request is already being processed.")

        newly_created_thread = not bool(thread_id)
        if thread_id:
            thread = _owned_thread(session, thread_id, user_id)
        else:
            thread = WebChatThread(user_id=user_id, title="New chat")
            session.add(thread)
            session.flush()

        edit_target: WebChatMessage | None = None
        if edit_message_id and existing_user_message is None:
            if not _env_bool("WEB_MESSAGE_EDIT_ENABLED", False):
                raise EditRequestError(
                    "message_edit_disabled", "Message editing is not enabled.", 503
                )
            any_target = session.get(WebChatMessage, edit_message_id)
            if any_target is None or any_target.user_id != user_id:
                raise EditRequestError(
                    "edit_not_authorized", "This message cannot be edited.", 404
                )
            if any_target.thread_id != thread.id:
                raise EditRequestError(
                    "edit_not_authorized", "This message does not belong to this chat.", 403
                )
            if any_target.role != "user" or any_target.superseded_at is not None:
                raise EditRequestError(
                    "stale_edit", "This message has already been replaced.", 409
                )
            active_request = session.exec(select(WebChatMessage).where(
                WebChatMessage.thread_id == thread.id,
                WebChatMessage.user_id == user_id,
                WebChatMessage.status == "pending",
                WebChatMessage.superseded_at.is_(None),
            )).first()
            if active_request is not None:
                raise EditRequestError(
                    "edit_conflict", "Wait for the active response to finish before editing.", 409
                )
            latest_user = session.exec(select(WebChatMessage).where(
                WebChatMessage.thread_id == thread.id,
                WebChatMessage.user_id == user_id,
                WebChatMessage.role == "user",
                WebChatMessage.superseded_at.is_(None),
            ).order_by(WebChatMessage.created_at.desc()).limit(1)).first()
            if latest_user is None or latest_user.id != any_target.id:
                raise EditRequestError(
                    "stale_edit", "Only the latest active user message can be edited.", 409
                )
            edit_target = any_target
            superseded_at = utc_now()
            edit_target.superseded_at = superseded_at
            session.add(edit_target)
            following_assistant = session.exec(select(WebChatMessage).where(
                WebChatMessage.thread_id == thread.id,
                WebChatMessage.user_id == user_id,
                WebChatMessage.role == "assistant",
                WebChatMessage.request_id == edit_target.request_id,
                WebChatMessage.superseded_at.is_(None),
            ).order_by(WebChatMessage.created_at.asc()).limit(1)).first()
            if following_assistant is not None:
                following_assistant.superseded_at = superseded_at
                session.add(following_assistant)
            for fact in session.exec(select(WebMemoryFact).where(
                WebMemoryFact.user_id == user_id,
                WebMemoryFact.source_message_id == edit_target.id,
                WebMemoryFact.deleted_at.is_(None),
            )).all():
                fact.deleted_at = superseded_at
                fact.updated_at = superseded_at
                session.add(fact)
            summary = session.exec(select(WebConversationSummary).where(
                WebConversationSummary.user_id == user_id,
                WebConversationSummary.thread_id == thread.id,
            )).first()
            if summary is not None:
                session.delete(summary)

        continuation_row: WebChatMessage | None = None
        if continue_message_id:
            continuation_row = session.exec(select(WebChatMessage).where(
                WebChatMessage.id == continue_message_id,
                WebChatMessage.thread_id == thread.id,
                WebChatMessage.user_id == user_id,
                WebChatMessage.role == "assistant",
                WebChatMessage.status == "complete",
                WebChatMessage.superseded_at.is_(None),
            )).first()
            if continuation_row is None:
                raise AttachmentRequestError(
                    "continuation_not_found", "The response to continue is no longer available.", 404
                )
            try:
                continuation_metadata = json.loads(continuation_row.metadata_json or "{}")
            except (TypeError, ValueError):
                continuation_metadata = {}
            if not bool(continuation_metadata.get("truncated")):
                raise AttachmentRequestError(
                    "continuation_not_allowed", "Only a truncated response can be continued.", 409
                )

        uploads = _load_attachments(user_id, attachment_ids or [])
        visible_message = message.strip()
        model_message = visible_message or "Review and summarize the attached document."
        if continuation_row is not None:
            visible_message = "Continue response"
            model_message = (
                "Continue the previous response exactly from where it stopped. "
                "Do not repeat completed sections; finish all remaining steps end-to-end."
            )
        display_attachments = [upload.display_metadata() for upload in uploads]
        visible_content = visible_message or (
            "Attached: " + ", ".join(upload.name for upload in uploads)
        )

        if existing_user_message is None:
            message_metadata = {
                "attachments": display_attachments,
                "input_mode": input_mode,
                "voice_turn_id": voice_turn_id,
                "reply_language": reply_language,
                "continue_message_id": continue_message_id,
            }
            session.add(WebChatMessage(
                thread_id=thread.id, user_id=user_id, role="user", content=visible_content,
                request_id=request_id, status="pending",
                metadata_json=json.dumps(message_metadata, ensure_ascii=False),
                replaces_message_id=edit_target.id if edit_target is not None else None,
                revision_number=(edit_target.revision_number + 1) if edit_target is not None else 1,
            ))
        thread.updated_at = utc_now()
        session.add(thread)

        enabled = optimizer_enabled()
        context_mode = normalize_same_thread_context_mode(
            os.getenv("WEB_SAME_THREAD_CONTEXT_MODE", "explicit_only")
        )
        try:
            configured_context_turns = max(
                0, int(os.getenv("WEB_CONTEXT_MAX_TURNS", "2"))
            )
        except (TypeError, ValueError):
            configured_context_turns = 2
        candidate_turn_limit = 6 if not enabled else max(2, configured_context_turns)
        previous_safe_metadata: dict[str, str] = {}
        if continuation_row is not None:
            try:
                continuation_safe = json.loads(continuation_row.metadata_json or "{}")
            except (TypeError, ValueError):
                continuation_safe = {}
            if isinstance(continuation_safe, dict):
                previous_safe_metadata = {
                    key: str(continuation_safe.get(key) or "")[:80]
                    for key in ("topic", "brand_subintent", "brand_profile_version")
                    if continuation_safe.get(key)
                }
            tail_limit = min(
                1_200, max(200, int(os.getenv("WEB_CONTINUE_TAIL_MAX_CHARS", "900")))
            )
            all_context = [{
                "user": "Previous truncated response",
                "assistant": continuation_row.content[-tail_limit:],
            }]
        elif newly_created_thread:
            all_context = []
        else:
            all_context, previous_safe_metadata = _context(
                session, thread.id, user_id, turn_limit=candidate_turn_limit
            )

        if continuation_row is not None and context_mode != "off":
            continuity = SameThreadContinuityDecision(
                mode=context_mode,
                use_context=True,
                reason="continue_response",
                confidence=1.0,
                preferred_turn_count=1,
            )
        else:
            continuity = decide_same_thread_continuity(
                model_message, all_context, mode=context_mode
            )

        coordinator = WebRequestCoordinator()
        needs_memory = needs_cross_thread_memory(model_message)
        preliminary = coordinator.preliminary(
            model_message, reply_language=reply_language,
            has_attachments=bool(uploads),
            previous_topic=previous_safe_metadata.get("topic"),
        )
        base_metadata = {
            "client_surface": "web", "billing_required": True, "cloud_only": True,
            "allow_local_rag": False, "allow_local_model": False, "skip_free_text_quota": True,
            "user_tier": "paid", "swico_tier": swico_tier,
            "attachment_count": len(uploads),
            "thread_title_seed": visible_message or (uploads[0].name if uploads else "New chat"),
            "max_provider_attempts": _max_provider_attempts(),
            "prompt_cache_enabled": _env_bool("WEB_PROMPT_CACHE_ENABLED", False),
            "prompt_cache_version": os.getenv("WEB_PROMPT_CACHE_VERSION", "v1"),
        }

        # Existing local routes remain ahead of profile/context selection,
        # cache/provider work, and therefore cannot create a reservation. The
        # bounded owner-scoped candidate read above is reused if a provider is needed.
        if preliminary.local_intent == "swico_brand" or (enabled and preliminary.local_intent):
            brand_metadata = (
                {
                    "topic": preliminary.brand_topic,
                    "brand_topic": preliminary.brand_topic,
                    "brand_subintent": preliminary.brand_subintent,
                    "brand_profile_version": preliminary.brand_profile_version,
                }
                if preliminary.local_intent == "swico_brand" else {}
            )
            ai_request = AIRequest(
                user_id=user_id, message=model_message, reply_language=reply_language,
                channel="text", request_id=request_id,
                metadata={**base_metadata, **brand_metadata},
            )
            if preliminary.local_intent == "swico_brand":
                route = AIRoute(
                    "backend_tool", None, "deterministic_swico_brand",
                    "approved_swico_public_profile",
                    str(reply_language or "en"), "swico_brand", 0,
                    metadata=brand_metadata,
                )
            else:
                route = AIProviderRouter().select_route(ai_request)
                if route.provider in {"openai", "sarvam"}:
                    route = AIRoute(
                        "backend_tool", None, "unsupported_web_capability",
                        "web_capability_not_available", route.language,
                        preliminary.local_intent, 0,
                    )
            session.commit()
            return PreparedWebTurn(
                request_id=request_id, user_id=user_id, thread_id=thread.id,
                ai_request=ai_request, route=route, reserved_micros=0,
                swico_tier=swico_tier, input_mode=input_mode,
                voice_turn_id=voice_turn_id, reply_language=str(reply_language or "en"),
                billing_exempt=billing_exempt, optimization=preliminary,
                continuity_decision=continuity,
                billing_credit_bucket=authoritative_bucket,
            )

        if (
            enabled
            and preliminary.cache_eligible
            and not needs_memory
            and not continuity.use_context
        ):
            cached = _cache_response(user_id, model_message, reply_language)
            if cached is not None:
                metrics = {
                    **preliminary.metrics,
                    "optimization_route": "approved_cache_hit",
                    "cache_hit": True,
                    "cache_hit_source": cached.raw.get("cache_hit_source") or "",
                }
                cached.raw.update(metrics)
                optimization = replace(
                    preliminary, optimization_route="approved_cache_hit", metrics=metrics
                )
                ai_request = AIRequest(
                    user_id=user_id, message=model_message, reply_language=reply_language,
                    channel="text", request_id=request_id, metadata=base_metadata,
                )
                route = AIRoute(
                    "cache", None, "global_knowledge_cache", "approved_global_cache_hit",
                    str(reply_language or "en"), "general", 0,
                )
                session.commit()
                return PreparedWebTurn(
                    request_id=request_id, user_id=user_id, thread_id=thread.id,
                    ai_request=ai_request, route=route, reserved_micros=0,
                    swico_tier=swico_tier, input_mode=input_mode,
                    voice_turn_id=voice_turn_id, reply_language=str(reply_language or "en"),
                    billing_exempt=billing_exempt, optimization=optimization,
                    precomputed_response=cached,
                    continuity_decision=continuity,
                    billing_credit_bucket=authoritative_bucket,
                )

        profile_context = build_profile_prompt_context(session, user_id)
        memory_selection = retrieve_memory(
            session, user_id=user_id, message=model_message,
            current_thread_id=thread.id,
        ) if needs_memory else None
        memory_context = memory_selection.prompt_context if memory_selection else ""
        try:
            attachment_context = select_attachment_context(uploads, visible_message)
        except FullDocumentConfirmationRequired as exc:
            raise AttachmentRequestError(
                "full_document_confirmation_required", str(exc), 422
            ) from exc
        coordinator_decision: WebRequestDecision | None = None
        if enabled:
            coordinator_decision = coordinator.decide(
                model_message, reply_language=reply_language,
                context_turns=all_context, profile_context=profile_context,
                attachment_context=attachment_context,
                memory_context=memory_context,
                needs_memory=needs_memory,
                has_attachments=bool(uploads),
                previous_topic=previous_safe_metadata.get("topic"),
                continuity=continuity,
            )
            optimization = coordinator_decision.optimization
            context_turns = optimization.selected_context_turns
            profile_prompt = optimization.compact_profile_prompt
            attachment_context = optimization.attachment_prompt_context
        else:
            context_turns, formatted_context = select_context_turns(
                all_context,
                contextual=continuity.use_context,
                preferred_turn_count=continuity.preferred_turn_count,
            )
            profile_prompt = profile_prompt_context_text(profile_context)
            optimization = replace(
                preliminary,
                optimization_route="legacy_optimizer_disabled",
                is_contextual_followup=continuity.use_context,
                selected_context_turns=context_turns,
                formatted_context=formatted_context,
                context_chars_sent=len(formatted_context),
                compact_profile_prompt=profile_prompt,
                profile_chars_sent=len(profile_prompt),
                attachment_prompt_context=attachment_context,
                attachment_chars_sent=len(attachment_context),
                metrics={
                    **preliminary.metrics,
                    "optimization_route": "legacy_optimizer_disabled",
                    "context_turns_sent": len(context_turns),
                    "context_chars_sent": len(formatted_context),
                    "profile_chars_sent": len(profile_prompt),
                    "attachment_chars_sent": len(attachment_context),
                },
            )

        metadata = {
            **base_metadata,
            "profile_context": profile_context,
            "profile_prompt_context": profile_prompt,
            "age_group": profile_context.get("age_group", ""),
            "attachment_prompt_context": attachment_context,
            "memory_prompt_context": memory_context,
            "answer_class": optimization.answer_class,
        }
        ai_request = AIRequest(
            user_id=user_id, message=model_message, reply_language=reply_language,
            channel="text", request_id=request_id, metadata=metadata,
            context_turns=context_turns,
        )
        route = AIProviderRouter().select_route(ai_request)

        if route.provider not in {"openai", "sarvam"}:
            # Deterministic safety blocks do not consume wallet credit.
            session.commit()
            return PreparedWebTurn(
                request_id=request_id, user_id=user_id, thread_id=thread.id,
                ai_request=ai_request, route=route, reserved_micros=0,
                swico_tier=swico_tier, input_mode=input_mode,
                voice_turn_id=voice_turn_id, reply_language=str(reply_language or "en"),
                billing_exempt=billing_exempt, optimization=optimization,
                coordinator_decision=coordinator_decision,
                continuity_decision=continuity,
                billing_credit_bucket=authoritative_bucket,
            )

        if enabled:
            route = replace(route, max_output_tokens=optimization.max_output_tokens)
        provider_messages = build_provider_messages(ai_request, route, provider=route.provider)
        serialized_prompt = serialize_provider_messages(provider_messages)
        if coordinator_decision is not None:
            coordinator_decision = coordinator.with_exact_prompt(
                coordinator_decision,
                serialized_prompt=serialized_prompt,
                system_prompt=str(provider_messages[0].get("content") or "") if provider_messages else "",
            )
            optimization = coordinator_decision.optimization
        else:
            optimization = with_prompt_estimate(optimization, serialized_prompt)
        input_tokens = optimization.estimated_prompt_tokens

        # Reorder only healthy candidates already admitted by the authoritative
        # selected Swico tier. Detailed/complex turns remain primary-first.
        if enabled and route.provider == "openai" and swico_tier:
            from ..openai_model_router import OpenAIModelRouter

            model_router = OpenAIModelRouter()
            selections = model_router.select_swico_candidates(
                swico_tier, model_message, user_tier="paid",
                estimated_input_tokens=input_tokens,
                max_output_tokens=route.max_output_tokens,
                answer_class=optimization.answer_class,
            )
            selection_meta = model_router.last_selection_metadata
            route = replace(
                route,
                model=selections[0].model,
                model_candidates=[item.model for item in selections],
                provider_endpoint_candidates=[item.endpoint for item in selections],
                metadata={
                    **route.metadata,
                    "primary_model_candidate": selection_meta.get("primary_model_candidate") or route.model,
                    "selected_model_reason": selection_meta.get("selected_model_reason") or "configured_swico_tier_primary_first",
                    "answer_class": optimization.answer_class,
                    "estimated_prompt_tokens": input_tokens,
                },
            )

        # Freeze the exact prompt after routing. Providers, budget guards and
        # usage estimates consume these same messages and token estimate.
        ai_request.metadata["provider_messages"] = provider_messages
        ai_request.metadata["serialized_provider_prompt"] = serialized_prompt
        ai_request.metadata["estimated_prompt_tokens"] = input_tokens
        if coordinator_decision is not None and _env_bool(
            "WEB_PROMPT_TOKEN_BREAKDOWN_ENABLED", True
        ):
            ai_request.metadata["coordinator_metadata"] = coordinator_decision.sanitized_metadata
        reserve = reserve_price(route.provider, route.model or "", input_tokens, route.max_output_tokens)
        if billing_exempt:
            create_billing_exempt_usage(
                session, request_id=request_id, user_id=user_id, thread_id=thread.id,
                provider=route.provider, model=route.model or "",
                pricing_snapshot_json=snapshot_json(reserve.snapshot),
                swico_tier=swico_tier,
                usage_kind="chat", credit_bucket=authoritative_bucket,
                voice_turn_id=voice_turn_id,
            )
        else:
            create_usage_reservation(
                session, request_id=request_id, user_id=user_id, thread_id=thread.id,
                provider=route.provider, model=route.model or "", reserved_micros=reserve.micros,
                pricing_snapshot_json=snapshot_json(reserve.snapshot),
                swico_tier=swico_tier,
                usage_kind="chat", credit_bucket=authoritative_bucket,
                voice_turn_id=voice_turn_id,
            )
        session.commit()
        return PreparedWebTurn(
            request_id=request_id, user_id=user_id, thread_id=thread.id,
            ai_request=ai_request, route=route,
            reserved_micros=0 if billing_exempt else reserve.micros,
            swico_tier=swico_tier, input_mode=input_mode,
            voice_turn_id=voice_turn_id, reply_language=str(reply_language or "en"),
            billing_exempt=billing_exempt,
            provider_messages=provider_messages, optimization=optimization,
            coordinator_decision=coordinator_decision,
            continuity_decision=continuity,
            billing_credit_bucket=authoritative_bucket,
        )


def _deterministic_response(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    tamil = str(
        request.reply_language or route.metadata.get("reply_language") or route.language
    ).strip().lower() in {"ta", "tamil", "mixed", "tanglish"}
    if route.intent == "swico_brand":
        text = swico_brand_response(
            str(route.metadata.get("brand_subintent") or "general"),
            reply_language=request.reply_language or route.language,
            message=request.message,
        )
    elif route.provider == "blocked":
        text = "I can’t help with that request, but I can help with a safer alternative."
    elif route.intent == "greeting":
        text = "வணக்கம்! இன்று நான் எப்படி உதவலாம்?" if tamil else "Hi! How can I help you today?"
    elif route.intent == "thanks":
        text = "வரவேற்கிறேன்." if tamil else "You’re welcome."
    elif route.intent == "capabilities":
        text = (
            "கேள்விகள், விளக்கங்கள், எழுதுதல், திட்டமிடல் மற்றும் நிரலாக்கத்தில் நான் உதவ முடியும்."
            if tamil else
            "I can help with questions, explanations, writing, planning, and coding."
        )
    else:
        text = "அந்த வசதி இன்னும் இணையத்தில் கிடைக்கவில்லை." if tamil else "That capability is not available on the web yet."
    return AIProviderResponse(
        text=text,
        provider="backend_tool" if route.intent == "swico_brand" else "blocked",
        model=None, route=route.route, reason=route.reason,
        language=route.language, intent=route.intent, characters=len(text),
        raw={
            "deterministic": True, "zero_charge": True,
            "provider_attempts": 0, "provider_calls_with_usage": 0,
            "fallback_attempted": False, "cache_hit": False,
        },
    )


def execute_web_turn(prepared: PreparedWebTurn, *, on_delta: Callable[[str], None] | None = None, providers: dict[str, Any] | None = None) -> CompletedWebTurn:
    if prepared.existing_response is not None:
        with SessionLocal() as session:
            message = session.get(WebChatMessage, prepared.existing_response.id)
            assert message is not None
            try:
                replay_metadata = json.loads(message.metadata_json or "{}")
            except (TypeError, ValueError):
                replay_metadata = {}
            response = AIProviderResponse(
                text=message.content, provider=message.provider or "", model=message.model,
                route="idempotent_replay", reason="already_complete", language="en", intent="replay",
                input_tokens=message.input_tokens, output_tokens=message.output_tokens,
                raw={
                    "finish_reason": str(replay_metadata.get("finish_reason") or "unknown"),
                    "truncated": bool(replay_metadata.get("truncated")),
                    "completion_status": str(
                        replay_metadata.get("completion_status") or "unknown"
                    ),
                    "usage_source": str(message.usage_source or "estimated"),
                    "provider_attempts": 0,
                    "provider_calls_with_usage": 0,
                },
            )
            if on_delta:
                on_delta(message.content)
            return CompletedWebTurn(
                prepared.thread_id,
                message,
                get_wallet_summary(
                    session, prepared.user_id, swico_tier=prepared.swico_tier,
                    billing_exempt=prepared.billing_exempt,
                    credit_bucket=prepared.billing_credit_bucket,
                ),
                response,
            )

    cancelled = False
    try:
        if prepared.precomputed_response is not None:
            response = prepared.precomputed_response
        elif prepared.route.provider in {"openai", "sarvam"}:
            provider_map = providers or {}
            provider = provider_map.get(prepared.route.provider)
            if provider is None:
                provider = OpenAIProvider() if prepared.route.provider == "openai" else SarvamProvider()
            if on_delta and hasattr(provider, "stream_complete"):
                response = provider.stream_complete(prepared.ai_request, prepared.route, on_delta)
            else:
                response = provider.complete(prepared.ai_request, prepared.route)
        else:
            response = _deterministic_response(prepared.ai_request, prepared.route)
        if on_delta and not (prepared.route.provider in {"openai", "sarvam"} and hasattr(provider, "stream_complete")):
            on_delta(response.text)
    except GenerationCancelled as exc:
        cancelled = True
        if exc.response is not None:
            response = exc.response
        else:
            with SessionLocal() as session:
                if prepared.billing_exempt:
                    release_billing_exempt_usage(
                        session, prepared.request_id,
                        reason="cancelled_before_provider_usage",
                    )
                else:
                    release_usage_reservation(
                        session, prepared.request_id,
                        reason="cancelled_before_provider_usage",
                    )
                user_message = session.exec(select(WebChatMessage).where(
                    WebChatMessage.user_id == prepared.user_id,
                    WebChatMessage.request_id == prepared.request_id,
                    WebChatMessage.role == "user",
                )).first()
                if user_message:
                    user_message.status = "retryable"
                    session.add(user_message)
                session.commit()
            raise
    except BaseException:
        with SessionLocal() as session:
            if prepared.billing_exempt:
                release_billing_exempt_usage(session, prepared.request_id)
            else:
                release_usage_reservation(session, prepared.request_id)
            user_message = session.exec(select(WebChatMessage).where(
                WebChatMessage.user_id == prepared.user_id,
                WebChatMessage.request_id == prepared.request_id,
                WebChatMessage.role == "user",
            )).first()
            if user_message:
                user_message.status = "retryable"
                session.add(user_message)
            session.commit()
        raise

    with SessionLocal() as session:
        user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == prepared.user_id,
            WebChatMessage.request_id == prepared.request_id,
            WebChatMessage.role == "user",
        )).one()
        optimization_metrics = dict(prepared.optimization.metrics if prepared.optimization else {})
        if prepared.coordinator_decision is not None:
            coordinator_metadata = prepared.coordinator_decision.sanitized_metadata
            if _env_bool("WEB_PROMPT_TOKEN_BREAKDOWN_ENABLED", True):
                optimization_metrics.update(coordinator_metadata)
            else:
                optimization_metrics.update({
                    key: coordinator_metadata[key]
                    for key in (
                        "same_thread_context_mode", "same_thread_context_reason",
                        "same_thread_context_confidence", "same_thread_context_turns_sent",
                        "same_thread_context_chars_sent", "same_thread_estimated_tokens",
                    )
                })
        elif prepared.continuity_decision is not None:
            same_thread_text = "\n".join(
                value
                for turn in prepared.ai_request.context_turns
                for value in (
                    str(turn.get("user") or ""), str(turn.get("assistant") or "")
                )
                if value
            )
            optimization_metrics.update({
                "same_thread_context_mode": prepared.continuity_decision.mode,
                "same_thread_context_reason": prepared.continuity_decision.reason,
                "same_thread_context_confidence": prepared.continuity_decision.confidence,
                "same_thread_context_turns_sent": len(prepared.ai_request.context_turns),
                "same_thread_context_chars_sent": len(same_thread_text),
                "same_thread_estimated_tokens": (
                    estimate_tokens(same_thread_text) if same_thread_text else 0
                ),
            })
        if prepared.ai_request.metadata.get("client_surface") == "web":
            for unsafe_key in ("original_message", "normalized_message", "stripped_prefix", "profile_context"):
                response.raw.pop(unsafe_key, None)
        provider_attempts = int(response.raw.get("provider_attempts") or 0)
        if prepared.route.provider in {"openai", "sarvam"} and provider_attempts <= 0:
            provider_attempts = 1
        provider_calls_with_usage = int(response.raw.get("provider_calls_with_usage") or 0)
        if response.raw.get("usage_actual") and provider_calls_with_usage <= 0:
            provider_calls_with_usage = 1
        optimization_metrics.update({
            "provider_attempts": provider_attempts,
            "provider_calls_with_usage": provider_calls_with_usage,
            "fallback_attempted": bool(response.raw.get("fallback_attempted")),
            "cache_hit": response.provider == "cache" or bool(response.raw.get("cache_hit")),
            "cache_hit_source": str(response.raw.get("cache_hit_source") or ""),
            "cached_input_tokens": int(response.raw.get("cached_input_tokens") or 0),
            "cache_write_tokens": int(response.raw.get("cache_write_tokens") or 0),
            "primary_model_candidate": str(
                response.raw.get("primary_model_candidate")
                or prepared.route.metadata.get("primary_model_candidate") or ""
            ),
            "selected_model": str(response.model or ""),
            "selected_model_reason": str(
                response.raw.get("selected_model_reason")
                or prepared.route.metadata.get("selected_model_reason") or ""
            ),
            "reserved_micros": int(prepared.reserved_micros),
            "finish_reason": str(response.raw.get("finish_reason") or "unknown"),
            "truncated": bool(response.raw.get("truncated")),
            "completion_status": str(
                response.raw.get("completion_status")
                or ("cancelled" if cancelled else "unknown")
            ),
        })
        response.raw.update(optimization_metrics)
        usage_source = "actual" if bool(response.raw.get("usage_actual")) else "estimated"
        optimization_metrics["usage_source"] = usage_source
        response.raw["usage_source"] = usage_source
        cached_tokens = int(response.raw.get("cached_input_tokens") or 0)
        price = price_usage(
            response.provider, response.model or "", response.input_tokens,
            response.output_tokens, cached_tokens,
        )
        if response.provider == "openai" and response.raw.get("actual_cost_usd") is not None:
            price = openai_reported_price(
                response.model or "", Decimal(str(response.raw["actual_cost_usd"])), price.snapshot
            )
        optimization_metrics["charged_micros"] = 0 if prepared.billing_exempt else price.micros
        response.raw["charged_micros"] = optimization_metrics["charged_micros"]
        assistant = WebChatMessage(
            thread_id=prepared.thread_id, user_id=prepared.user_id, role="assistant",
            content=response.text or "Generation stopped.", request_id=prepared.request_id, provider=response.provider,
            model=response.model, swico_tier=prepared.swico_tier,
            input_tokens=response.input_tokens, output_tokens=response.output_tokens,
            usage_source=(
                usage_source
                if prepared.route.provider in {"openai", "sarvam"} else None
            ),
            charge_micros=0 if prepared.billing_exempt else price.micros,
            status="cancelled" if cancelled else "complete",
            metadata_json=json.dumps({
                "input_mode": prepared.input_mode,
                "voice_turn_id": prepared.voice_turn_id,
                "reply_language": prepared.reply_language,
                "billing_credit_bucket": prepared.billing_credit_bucket,
                **optimization_metrics,
            }, sort_keys=True, separators=(",", ":")),
        )
        session.add(assistant)
        # UsageCharge references this message. An explicit flush guarantees the
        # FK target exists before settlement updates the charge on every SQLAlchemy dialect.
        session.flush([assistant])
        user_message.status = "complete" if not cancelled else "cancelled"
        session.add(user_message)
        if prepared.billing_exempt and prepared.route.provider in {"openai", "sarvam"}:
            settle_billing_exempt_usage(
                session, request_id=prepared.request_id,
                provider_cost_amount=price.amount,
                provider_cost_currency=price.currency,
                provider_cost_micros=price.micros,
                input_tokens=response.input_tokens,
                cached_input_tokens=cached_tokens,
                output_tokens=response.output_tokens,
                usage_source=usage_source,
                pricing_snapshot_json=snapshot_json(price.snapshot),
                usd_to_inr_rate=(
                    env_decimal("USD_TO_INR_BILLING_RATE", "90")
                    if response.provider == "openai" else None
                ),
                assistant_message_id=assistant.id,
                provider=response.provider,
                model=response.model or "",
                usage_kind="chat", voice_turn_id=prepared.voice_turn_id,
                swico_tier=prepared.swico_tier,
            )
        elif prepared.reserved_micros:
            settle_usage_reservation(
                session, request_id=prepared.request_id, provider_cost_amount=price.amount,
                provider_cost_currency=price.currency, provider_cost_micros=price.micros,
                input_tokens=response.input_tokens, cached_input_tokens=cached_tokens,
                output_tokens=response.output_tokens, usage_source=usage_source,
                pricing_snapshot_json=snapshot_json(price.snapshot),
                usd_to_inr_rate=env_decimal("USD_TO_INR_BILLING_RATE", "90") if response.provider == "openai" else None,
                assistant_message_id=assistant.id,
                provider=response.provider, model=response.model or "",
                usage_kind="chat", voice_turn_id=prepared.voice_turn_id,
                swico_tier=prepared.swico_tier,
            )
        thread = _owned_thread(session, prepared.thread_id, prepared.user_id)
        if thread.title == "New chat":
            thread.title = deterministic_title(
                str(prepared.ai_request.metadata.get("thread_title_seed") or prepared.ai_request.message)
            )
        thread.updated_at = utc_now()
        session.add(thread)
        session.commit()
        session.refresh(assistant)

        if assistant.status == "complete":
            try:
                with SessionLocal() as memory_session:
                    memory_user = memory_session.get(WebChatMessage, user_message.id)
                    memory_assistant = memory_session.get(WebChatMessage, assistant.id)
                    if memory_user is not None and memory_assistant is not None:
                        write_turn_memory(
                            memory_session, user_id=prepared.user_id,
                            thread_id=prepared.thread_id,
                            user_message=memory_user, assistant_message=memory_assistant,
                            answer_class=(prepared.optimization.answer_class if prepared.optimization else "normal"),
                        )
                        memory_session.commit()
            except Exception:
                logger.exception(
                    "web_memory_write_failed",
                    extra={"request_id": prepared.request_id, "thread_id": prepared.thread_id},
                )

        if (
            response.provider == "openai"
            and assistant.status == "complete"
            and prepared.optimization is not None
            and prepared.optimization.cache_eligible
            and _env_bool("AI_ROUTER_GLOBAL_CACHE_RECORD_ENABLED", True)
        ):
            try:
                from ..global_qa_cache import record_backend_openai_answer

                record_backend_openai_answer(
                    session, prepared.user_id, prepared.ai_request.message,
                    response.text, response.model, request_id=prepared.request_id,
                )
            except Exception:
                session.rollback()

        logger.info(
            "web_turn_optimized",
            extra={
                "event": "web_turn_optimized",
                **{
                    key: optimization_metrics.get(key)
                    for key in (
                        "optimization_route", "answer_class", "context_turns_sent",
                        "context_chars_sent", "profile_chars_sent", "attachment_chars_sent",
                        "cache_hit", "cache_hit_source", "estimated_prompt_tokens",
                        "max_output_tokens", "provider_attempts", "provider_calls_with_usage",
                        "fallback_attempted", "reserved_micros", "charged_micros",
                        "cached_input_tokens", "cache_write_tokens", "primary_model_candidate",
                        "selected_model", "selected_model_reason",
                        "system_prompt_estimated_tokens", "user_message_estimated_tokens",
                        "same_thread_estimated_tokens", "memory_estimated_tokens",
                        "profile_estimated_tokens", "attachment_estimated_tokens",
                        "total_estimated_prompt_tokens", "usage_source", "finish_reason",
                        "truncated", "completion_status",
                        "same_thread_context_mode", "same_thread_context_reason",
                        "same_thread_context_confidence", "same_thread_context_turns_sent",
                        "same_thread_context_chars_sent",
                    )
                },
            },
        )
        wallet = get_wallet_summary(
            session, prepared.user_id, swico_tier=prepared.swico_tier,
            billing_exempt=prepared.billing_exempt,
            credit_bucket=prepared.billing_credit_bucket,
        )
        return CompletedWebTurn(prepared.thread_id, assistant, wallet, response)
