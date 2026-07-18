from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
import json
import os
from typing import Any, Callable

from sqlmodel import Session, select

from ..ai.prompts import build_provider_messages
from ..ai.providers.openai_provider import OpenAIProvider
from ..ai.providers.sarvam_provider import SarvamProvider
from ..ai.providers.base import GenerationCancelled
from ..ai.router import AIProviderRouter
from ..ai.types import AIProviderResponse, AIRequest, AIRoute
from ..billing.pricing import estimate_tokens, env_decimal, openai_reported_price, price_usage, reserve_price, snapshot_json
from ..billing.service import (
    create_billing_exempt_usage, create_usage_reservation, get_wallet_summary,
    release_billing_exempt_usage, release_usage_reservation,
    settle_billing_exempt_usage, settle_usage_reservation,
)
from ..database import SessionLocal
from ..models import UsageCharge, WebChatMessage, WebChatThread
from ..profile_context import build_profile_prompt_context, profile_prompt_context_text
from ..time_utils import utc_now
from .attachment_context import select_attachment_context
from .upload_store import UploadStoreUnavailable, get_upload_store
from .usage_service import selected_swico_tier


class DuplicateRequestInProgress(RuntimeError):
    pass


class AttachmentRequestError(RuntimeError):
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


def _context(session: Session, thread_id: str, user_id: int, limit: int = 20) -> list[dict[str, str]]:
    rows = list(session.exec(
        select(WebChatMessage).where(
            WebChatMessage.thread_id == thread_id,
            WebChatMessage.user_id == user_id,
            WebChatMessage.status == "complete",
        ).order_by(WebChatMessage.created_at.desc()).limit(limit)
    ).all())
    turns: list[dict[str, str]] = []
    pending: WebChatMessage | None = None
    for row in reversed(rows):
        if row.role == "user":
            pending = row
        elif row.role == "assistant" and pending is not None:
            if pending.request_id and row.request_id and pending.request_id != row.request_id:
                continue
            turns.append({"user": pending.content, "assistant": row.content})
            pending = None
    return turns[-6:]


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
) -> PreparedWebTurn:
    with SessionLocal() as session:
        swico_tier = selected_swico_tier(session, user_id)
        existing_assistant = session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == user_id,
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "assistant",
        )).first()
        if existing_assistant is not None:
            thread = _owned_thread(session, existing_assistant.thread_id, user_id)
            dummy = AIRequest(user_id, message, reply_language, "text", request_id, {})
            route = AIRoute("blocked", None, "idempotent_replay", "already_complete", "en", "replay", 0)
            return PreparedWebTurn(
                request_id, user_id, thread.id, dummy, route, 0, swico_tier,
                input_mode, voice_turn_id, str(reply_language or "en"),
                billing_exempt, existing_assistant,
            )

        existing_user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == user_id,
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "user",
        )).first()
        existing_charge = session.exec(select(UsageCharge).where(UsageCharge.request_id == request_id)).first()
        if existing_user_message is not None and existing_charge is not None and existing_charge.status != "released":
            raise DuplicateRequestInProgress("This request is already being processed.")

        uploads = _load_attachments(user_id, attachment_ids or [])

        if thread_id:
            thread = _owned_thread(session, thread_id, user_id)
        else:
            thread = WebChatThread(user_id=user_id, title="New chat")
            session.add(thread)
            session.flush()

        context_turns = _context(session, thread.id, user_id)
        visible_message = message.strip()
        model_message = visible_message or "Review and summarize the attached document."
        display_attachments = [upload.display_metadata() for upload in uploads]
        visible_content = visible_message or (
            "Attached: " + ", ".join(upload.name for upload in uploads)
        )
        profile_context = build_profile_prompt_context(session, user_id)
        attachment_context = select_attachment_context(uploads, visible_message)
        ai_request = AIRequest(
            user_id=user_id, message=model_message, reply_language=reply_language, channel="text",
            request_id=request_id,
            metadata={
                "client_surface": "web", "billing_required": True, "cloud_only": True,
                "allow_local_rag": False, "allow_local_model": False, "skip_free_text_quota": True,
                "user_tier": "paid",
                "swico_tier": swico_tier,
                "profile_context": profile_context,
                "profile_prompt_context": profile_prompt_context_text(profile_context),
                "age_group": profile_context.get("age_group", ""),
                "attachment_prompt_context": attachment_context,
                "attachment_count": len(uploads),
                "thread_title_seed": visible_message or (uploads[0].name if uploads else "New chat"),
            },
            context_turns=context_turns,
        )
        route = AIProviderRouter().select_route(ai_request)

        if existing_user_message is None:
            message_metadata = {
                "attachments": display_attachments,
                "input_mode": input_mode,
                "voice_turn_id": voice_turn_id,
                "reply_language": reply_language,
            }
            session.add(WebChatMessage(
                thread_id=thread.id, user_id=user_id, role="user", content=visible_content,
                request_id=request_id, status="pending",
                metadata_json=json.dumps(message_metadata, ensure_ascii=False),
            ))
        thread.updated_at = utc_now()
        session.add(thread)

        if route.provider not in {"openai", "sarvam"}:
            # Deterministic safety blocks do not consume wallet credit.
            session.commit()
            return PreparedWebTurn(
                request_id, user_id, thread.id, ai_request, route, 0,
                swico_tier, input_mode, voice_turn_id, str(reply_language or "en"),
                billing_exempt,
            )

        provider_messages = build_provider_messages(ai_request, route, provider=route.provider)
        input_tokens = sum(estimate_tokens(item.get("content", "")) for item in provider_messages)
        reserve = reserve_price(route.provider, route.model or "", input_tokens, route.max_output_tokens)
        if billing_exempt:
            create_billing_exempt_usage(
                session, request_id=request_id, user_id=user_id, thread_id=thread.id,
                provider=route.provider, model=route.model or "",
                pricing_snapshot_json=snapshot_json(reserve.snapshot),
                swico_tier=swico_tier,
                usage_kind="chat", voice_turn_id=voice_turn_id,
            )
        else:
            create_usage_reservation(
                session, request_id=request_id, user_id=user_id, thread_id=thread.id,
                provider=route.provider, model=route.model or "", reserved_micros=reserve.micros,
                pricing_snapshot_json=snapshot_json(reserve.snapshot),
                swico_tier=swico_tier,
                usage_kind="chat", voice_turn_id=voice_turn_id,
            )
        session.commit()
        return PreparedWebTurn(
            request_id, user_id, thread.id, ai_request, route,
            0 if billing_exempt else reserve.micros, swico_tier,
            input_mode, voice_turn_id, str(reply_language or "en"), billing_exempt,
        )


def _deterministic_response(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    tamil = str(
        request.reply_language or route.metadata.get("reply_language") or route.language
    ).strip().lower() in {"ta", "tamil", "mixed", "tanglish"}
    if route.provider == "blocked":
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
        text=text, provider="blocked", model=None, route=route.route, reason=route.reason,
        language=route.language, intent=route.intent, characters=len(text),
        raw={"deterministic": True, "zero_charge": True},
    )


def execute_web_turn(prepared: PreparedWebTurn, *, on_delta: Callable[[str], None] | None = None, providers: dict[str, Any] | None = None) -> CompletedWebTurn:
    if prepared.existing_response is not None:
        with SessionLocal() as session:
            message = session.get(WebChatMessage, prepared.existing_response.id)
            assert message is not None
            response = AIProviderResponse(
                text=message.content, provider=message.provider or "", model=message.model,
                route="idempotent_replay", reason="already_complete", language="en", intent="replay",
                input_tokens=message.input_tokens, output_tokens=message.output_tokens,
            )
            if on_delta:
                on_delta(message.content)
            return CompletedWebTurn(
                prepared.thread_id,
                message,
                get_wallet_summary(
                    session, prepared.user_id, swico_tier=prepared.swico_tier,
                    billing_exempt=prepared.billing_exempt,
                ),
                response,
            )

    cancelled = False
    try:
        if prepared.route.provider in {"openai", "sarvam"}:
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
        usage_source = "actual" if bool(response.raw.get("usage_actual")) else "estimated"
        cached_tokens = int(response.raw.get("cached_input_tokens") or 0)
        price = price_usage(
            response.provider, response.model or "", response.input_tokens,
            response.output_tokens, cached_tokens,
        )
        if response.provider == "openai" and response.raw.get("actual_cost_usd") is not None:
            price = openai_reported_price(
                response.model or "", Decimal(str(response.raw["actual_cost_usd"])), price.snapshot
            )
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
        wallet = get_wallet_summary(
            session, prepared.user_id, swico_tier=prepared.swico_tier,
            billing_exempt=prepared.billing_exempt,
        )
        return CompletedWebTurn(prepared.thread_id, assistant, wallet, response)
