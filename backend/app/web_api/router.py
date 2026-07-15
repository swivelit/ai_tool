from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete as sa_delete, text, update as sa_update
from sqlmodel import Session, select

from ..auth import AuthUser, get_current_user, get_owned_user
from ..billing.errors import InsufficientCreditError, PaymentValidationError, RateLimitError
from ..billing.pricing import calculate_topup, credit_percent
from ..billing.razorpay_client import RazorpayClient, verify_checkout_signature, verify_webhook_signature
from ..billing.schemas import CreateOrderRequest, VerifyPaymentRequest
from ..billing.service import (
    credit_payment_once, enforce_rate_limit, get_wallet_summary, list_wallet_ledger,
    reverse_credit_for_refund,
)
from ..database import SessionLocal, get_session
from ..models import PaymentOrder, ProcessedWebhook, UsageCharge, WebChatMessage, WebChatThread
from ..time_utils import utc_now
from .chat_service import DuplicateRequestInProgress, execute_web_turn, prepare_web_turn
from .schemas import ThreadCreate, ThreadPatch, WebChatRequest

router = APIRouter(prefix="/api/web", tags=["web"])
logger = logging.getLogger(__name__)


def _rate_limit(session: Session, *, user_id: int, action: str, limit: int) -> None:
    try:
        enforce_rate_limit(session, user_id=user_id, action=action, limit=limit)
    except RateLimitError as exc:
        raise HTTPException(429, str(exc), headers={"Retry-After": "60"}) from exc


def _pagination(limit: int, offset: int) -> tuple[int, int]:
    return min(max(1, limit), 100), max(0, offset)


def _packages() -> list[int]:
    raw = os.getenv("BILLING_TOPUP_PACKAGES_PAISE", "1000,5000,10000,50000")
    packages: list[int] = []
    for item in raw.split(","):
        try:
            value = int(item.strip())
        except ValueError:
            continue
        if value > 0 and value not in packages:
            packages.append(value)
    return packages


def public_billing_config() -> dict[str, Any]:
    packages = []
    for gross in _packages():
        credit_micros, platform_paise = calculate_topup(gross)
        packages.append({
            "gross_amount_paise": gross,
            "credited_amount_micros": credit_micros,
            "platform_share_paise": platform_paise,
        })
    return {
        "currency": "INR", "credit_percent": str(credit_percent()),
        "razorpay_key_id": os.getenv("RAZORPAY_KEY_ID", "").strip(),
        "min_topup_paise": int(os.getenv("BILLING_MIN_TOPUP_PAISE", "1000")),
        "max_topup_paise": int(os.getenv("BILLING_MAX_TOPUP_PAISE", "50000")),
        "packages": packages,
    }


def _serialize_thread(row: WebChatThread) -> dict[str, Any]:
    return {
        "id": row.id, "title": row.title, "archived_at": row.archived_at,
        "created_at": row.created_at, "updated_at": row.updated_at,
    }


def _serialize_message(row: WebChatMessage) -> dict[str, Any]:
    return {
        "id": row.id, "thread_id": row.thread_id, "role": row.role, "content": row.content,
        "request_id": row.request_id, "provider": row.provider, "model": row.model,
        "input_tokens": row.input_tokens, "output_tokens": row.output_tokens,
        "usage_source": row.usage_source, "charge_micros": row.charge_micros,
        "status": row.status, "created_at": row.created_at,
    }


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
    return public_billing_config()


@router.get("/bootstrap")
def bootstrap(session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    return {
        "user": {"id": user.id, "name": user.name, "email": user.email, "reply_language": user.reply_language},
        "wallet": get_wallet_summary(session, int(user.id)),
        "billing": public_billing_config(),
        "features": {"web_chat": True, "prepaid_billing": True, "local_models": False},
    }


@router.get("/threads")
def list_threads(
    archived: bool = False, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    condition = WebChatThread.archived_at.is_not(None) if archived else WebChatThread.archived_at.is_(None)
    rows = session.exec(select(WebChatThread).where(
        WebChatThread.user_id == user.id, condition
    ).order_by(WebChatThread.updated_at.desc()).offset(offset).limit(limit)).all()
    return {"items": [_serialize_thread(row) for row in rows], "limit": limit, "offset": offset}


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
    thread_id: str, limit: int = Query(100, ge=1, le=200), offset: int = Query(0, ge=0),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    _owned_thread(session, int(user.id), thread_id)
    rows = session.exec(select(WebChatMessage).where(
        WebChatMessage.thread_id == thread_id, WebChatMessage.user_id == user.id
    ).order_by(WebChatMessage.created_at.asc()).offset(offset).limit(limit)).all()
    return {"items": [_serialize_message(row) for row in rows], "limit": limit, "offset": offset}


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


@router.post("/chat/stream")
async def chat_stream(payload: WebChatRequest, auth: AuthUser = Depends(get_current_user)):
    with SessionLocal() as rate_session:
        user = get_owned_user(rate_session, auth)
        user_id = int(user.id)
        _rate_limit(rate_session, user_id=user_id, action="web_chat", limit=int(os.getenv("WEB_CHAT_RATE_LIMIT_PER_MINUTE", "12")))
        rate_session.commit()
    try:
        prepared = await asyncio.to_thread(
            prepare_web_turn, user_id=user_id, message=payload.message,
            request_id=str(payload.request_id), thread_id=str(payload.thread_id) if payload.thread_id else None,
            reply_language=payload.reply_language,
        )
    except InsufficientCreditError as exc:
        return JSONResponse(status_code=402, content={"error": {
            "code": "insufficient_credit", "message": "Add AI credit to continue.",
            "available_micros": exc.available_micros,
            "estimated_required_micros": exc.estimated_required_micros,
        }})
    except LookupError:
        raise HTTPException(404, "Thread not found")
    except DuplicateRequestInProgress as exc:
        raise HTTPException(409, str(exc))

    async def events():
        queue: asyncio.Queue[str] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def delta(value: str) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, value)

        task = asyncio.create_task(asyncio.to_thread(execute_web_turn, prepared, on_delta=delta))
        yield _sse("thread", {"thread_id": prepared.thread_id})
        yield _sse("status", {"phase": "routing"})
        if prepared.reserved_micros:
            yield _sse("status", {"phase": "reserved", "reserved_micros": prepared.reserved_micros})
        try:
            while not task.done():
                try:
                    chunk = await asyncio.wait_for(queue.get(), timeout=0.15)
                    yield _sse("delta", {"text": chunk})
                except asyncio.TimeoutError:
                    continue
            while not queue.empty():
                yield _sse("delta", {"text": queue.get_nowait()})
            completed = await task
            response = completed.response
            yield _sse("usage", {
                "provider": response.provider, "model": response.model,
                "input_tokens": response.input_tokens, "output_tokens": response.output_tokens,
                "usage_source": completed.message.usage_source,
                "charged_micros": completed.message.charge_micros,
            })
            yield _sse("wallet", completed.wallet)
            yield _sse("done", {"message_id": completed.message.id, "thread_id": completed.thread_id})
        except asyncio.CancelledError:
            # The worker either settles provider-reported usage or releases the reservation.
            raise
        except Exception:
            logger.exception("web_chat_generation_failed", extra={"request_id": prepared.request_id})
            yield _sse("error", {"code": "generation_failed", "message": "The AI provider could not complete this request. Please retry."})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/billing/wallet")
def wallet(session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    return get_wallet_summary(session, int(user.id))


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
    } for row in rows]}


@router.get("/billing/payments")
def payments(
    limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
    session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user),
):
    user = get_owned_user(session, auth)
    rows = session.exec(select(PaymentOrder).where(PaymentOrder.user_id == user.id)
        .order_by(PaymentOrder.created_at.desc()).offset(offset).limit(limit)).all()
    return {"items": [{
        "id": row.id, "gross_amount_paise": row.gross_amount_paise,
        "credited_amount_micros": row.credited_amount_micros,
        "platform_share_paise": row.platform_share_paise, "refunded_amount_paise": row.refunded_amount_paise,
        "status": row.status, "created_at": row.created_at,
    } for row in rows]}


@router.post("/billing/orders", status_code=201)
def create_order(payload: CreateOrderRequest, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = get_owned_user(session, auth)
    _rate_limit(session, user_id=int(user.id), action="payment_order", limit=6)
    minimum = int(os.getenv("BILLING_MIN_TOPUP_PAISE", "1000"))
    maximum = int(os.getenv("BILLING_MAX_TOPUP_PAISE", "50000"))
    if payload.gross_amount_paise < minimum or payload.gross_amount_paise > maximum:
        raise HTTPException(422, f"Top-up must be between {minimum} and {maximum} paise.")
    allowed = _packages()
    if os.getenv("BILLING_ENFORCE_TOPUP_PACKAGES", "true").lower() in {"1", "true", "yes", "on"} and payload.gross_amount_paise not in allowed:
        raise HTTPException(422, "Select an available top-up package.")
    digest = hashlib.sha256(f"{user.id}:{payload.idempotency_key}".encode()).hexdigest()[:26]
    receipt = f"sw_{digest}"[:40]
    existing = session.exec(select(PaymentOrder).where(PaymentOrder.receipt == receipt, PaymentOrder.user_id == user.id)).first()
    if existing and existing.provider_order_id:
        return _order_checkout_response(existing)
    credit_micros, platform_paise = calculate_topup(payload.gross_amount_paise)
    order = existing or PaymentOrder(
        user_id=int(user.id), receipt=receipt, gross_amount_paise=payload.gross_amount_paise,
        credited_amount_micros=credit_micros, platform_share_paise=platform_paise,
    )
    if existing and existing.gross_amount_paise != payload.gross_amount_paise:
        raise HTTPException(409, "Idempotency key was already used for another amount.")
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
    return {"status": "credited", "credited": True, "wallet": get_wallet_summary(session, int(user.id))}


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
            reverse_credit_for_refund(session, order, order.refunded_amount_paise + amount)
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
