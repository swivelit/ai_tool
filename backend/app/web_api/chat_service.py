from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
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
    create_usage_reservation, get_wallet_summary, release_usage_reservation,
    settle_usage_reservation,
)
from ..database import SessionLocal
from ..models import UsageCharge, WebChatMessage, WebChatThread
from ..time_utils import utc_now
from .usage_service import selected_swico_tier


class DuplicateRequestInProgress(RuntimeError):
    pass


@dataclass
class PreparedWebTurn:
    request_id: str
    user_id: int
    thread_id: str
    ai_request: AIRequest
    route: AIRoute
    reserved_micros: int
    swico_tier: str
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
    return [{"role": row.role, "content": row.content} for row in reversed(rows)]


def prepare_web_turn(*, user_id: int, message: str, request_id: str, thread_id: str | None, reply_language: str | None) -> PreparedWebTurn:
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
                request_id, user_id, thread.id, dummy, route, 0, swico_tier, existing_assistant
            )

        existing_user_message = session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == user_id,
            WebChatMessage.request_id == request_id,
            WebChatMessage.role == "user",
        )).first()
        existing_charge = session.exec(select(UsageCharge).where(UsageCharge.request_id == request_id)).first()
        if existing_user_message is not None and existing_charge is not None and existing_charge.status != "released":
            raise DuplicateRequestInProgress("This request is already being processed.")

        if thread_id:
            thread = _owned_thread(session, thread_id, user_id)
        else:
            thread = WebChatThread(user_id=user_id, title="New chat")
            session.add(thread)
            session.flush()

        context_turns = _context(session, thread.id, user_id)
        ai_request = AIRequest(
            user_id=user_id, message=message, reply_language=reply_language, channel="text",
            request_id=request_id,
            metadata={
                "client_surface": "web", "billing_required": True, "cloud_only": True,
                "allow_local_rag": False, "allow_local_model": False, "skip_free_text_quota": True,
                "user_tier": "paid",
                "swico_tier": swico_tier,
            },
            context_turns=context_turns,
        )
        route = AIProviderRouter().select_route(ai_request)

        if existing_user_message is None:
            session.add(WebChatMessage(
                thread_id=thread.id, user_id=user_id, role="user", content=message,
                request_id=request_id, status="pending",
            ))
        thread.updated_at = utc_now()
        session.add(thread)

        if route.provider not in {"openai", "sarvam"}:
            # Deterministic safety blocks do not consume wallet credit.
            session.commit()
            return PreparedWebTurn(request_id, user_id, thread.id, ai_request, route, 0, swico_tier)

        provider_messages = build_provider_messages(ai_request, route, provider=route.provider)
        input_tokens = sum(estimate_tokens(item.get("content", "")) for item in provider_messages)
        reserve = reserve_price(route.provider, route.model or "", input_tokens, route.max_output_tokens)
        create_usage_reservation(
            session, request_id=request_id, user_id=user_id, thread_id=thread.id,
            provider=route.provider, model=route.model or "", reserved_micros=reserve.micros,
            pricing_snapshot_json=snapshot_json(reserve.snapshot),
            swico_tier=swico_tier,
        )
        session.commit()
        return PreparedWebTurn(
            request_id, user_id, thread.id, ai_request, route, reserve.micros, swico_tier
        )


def _deterministic_response(request: AIRequest, route: AIRoute) -> AIProviderResponse:
    text = (
        "I can’t help with that request, but I can help with a safer alternative."
        if route.provider == "blocked" else
        "Swico cannot complete this request through the current web route."
    )
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
                get_wallet_summary(session, prepared.user_id, swico_tier=prepared.swico_tier),
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
                release_usage_reservation(session, prepared.request_id, reason="cancelled_before_provider_usage")
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
            usage_source=usage_source, charge_micros=price.micros, status="cancelled" if cancelled else "complete",
        )
        session.add(assistant)
        # UsageCharge references this message. An explicit flush guarantees the
        # FK target exists before settlement updates the charge on every SQLAlchemy dialect.
        session.flush([assistant])
        user_message.status = "complete" if not cancelled else "cancelled"
        session.add(user_message)
        if prepared.reserved_micros:
            settle_usage_reservation(
                session, request_id=prepared.request_id, provider_cost_amount=price.amount,
                provider_cost_currency=price.currency, provider_cost_micros=price.micros,
                input_tokens=response.input_tokens, cached_input_tokens=cached_tokens,
                output_tokens=response.output_tokens, usage_source=usage_source,
                pricing_snapshot_json=snapshot_json(price.snapshot),
                usd_to_inr_rate=env_decimal("USD_TO_INR_BILLING_RATE", "90") if response.provider == "openai" else None,
                assistant_message_id=assistant.id,
                provider=response.provider, model=response.model or "",
            )
        thread = _owned_thread(session, prepared.thread_id, prepared.user_id)
        if thread.title == "New chat":
            thread.title = deterministic_title(prepared.ai_request.message)
        thread.updated_at = utc_now()
        session.add(thread)
        session.commit()
        session.refresh(assistant)
        wallet = get_wallet_summary(session, prepared.user_id, swico_tier=prepared.swico_tier)
        return CompletedWebTurn(prepared.thread_id, assistant, wallet, response)
