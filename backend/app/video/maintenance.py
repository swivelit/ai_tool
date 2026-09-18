"""Existing API process, bounded thread; DB-leased outboxes, no new service."""
from __future__ import annotations
import json
import logging
import threading
from datetime import timedelta
from zoneinfo import ZoneInfo
from sqlmodel import select
from ..database import SessionLocal
from ..models import PaymentOrder, User
from ..email_service import get_email_sender
from ..billing.razorpay_client import RazorpayClient
from ..billing.service import reverse_credit_for_refund
from . import service as svc
from .cache import cache
from .config import settings
from .models import VideoJob, VideoOutbox, now

log = logging.getLogger(__name__)
_stop = threading.Event()
_thread = None


def sweep():
    cleanup = []
    with SessionLocal() as session:
        row = svc.control(session)
        if row.maintenance_until and svc.utc(row.maintenance_until) > now():
            return
        row.maintenance_until = now() + timedelta(seconds=20)
        session.add(row)
        # Terminal rows cannot starve active deadlines. Mark successful media cleanup
        # durably so retries after API death do not rescan all financial history.
        jobs = session.exec(select(VideoJob).where(VideoJob.state.not_in(svc.TERMINAL - {"ready"})).order_by(VideoJob.created_at).limit(100)).all()
        jobs += session.exec(select(VideoJob).where(VideoJob.state.in_(svc.TERMINAL - {"ready"}), VideoJob.phase != "media_deleted").order_by(VideoJob.created_at).limit(100)).all()
        for job in jobs:
            if job.expires_at and svc.utc(job.expires_at) <= now():
                job.state = "expired"
                cleanup.append(job.id)
            elif job.state == "ready":
                try:
                    available = cache().has_output(job.id)
                except Exception:
                    continue  # Transient connectivity is not evidence of permanent loss.
                if not available:
                    svc.fail(session, job, "artifact_lost_before_expiry")
                    cleanup.append(job.id)
            elif job.state in {"failed", "cancelled", "refund_pending", "refunded", "expired"}:
                cleanup.append(job.id)
            elif job.state == "checkout" and (now() - svc.utc(job.admitted_at)).total_seconds() > 300:
                svc.fail(session, job, "checkout_hold_expired")
                cleanup.append(job.id)
            elif job.state not in svc.TERMINAL and svc.utc(job.deadline) <= now():
                svc.fail(session, job, "job_deadline_exceeded")
                cleanup.append(job.id)
            elif job.lease_until and svc.utc(job.lease_until) <= now() and job.state in {"processing", "preflighting"}:
                # Pure local rendering can retry from frozen originals; never retry payments.
                if job.attempt < 3:
                    try:
                        cache().clear_output(job.id)
                    except Exception:
                        continue  # Deadline compensation above still runs during outages.
                    job.output_hash, job.output_size = "", 0
                    job.state = "queued" if job.state == "processing" else "preflight_queued"
                    job.fence, job.lease_until, job.progress = "", None, 0
                    job.started_at = None
                else:
                    svc.fail(session, job, "worker_lease_exhausted")
                    cleanup.append(job.id)
            session.add(job)
        session.commit()
    for job_id in cleanup:
        cache().delete(job_id)
        with SessionLocal() as session:
            job = session.get(VideoJob, job_id)
            if job and job.state in svc.TERMINAL - {"ready"}:
                job.phase = "media_deleted"
                session.add(job)
                session.commit()


def deliver_one():
    with SessionLocal() as session:
        intent = session.exec(select(VideoOutbox).where(VideoOutbox.state.in_({"pending", "submitted", "sending", "ambiguous"}), VideoOutbox.due_at <= now()).order_by(VideoOutbox.due_at).with_for_update(skip_locked=True).limit(1)).first()
        if not intent:
            return
        job = session.get(VideoJob, intent.job_id)
        if intent.kind == "ready_email" and (job.state != "ready" or svc.utc(job.expires_at) <= now()):
            intent.state = "expired"
            session.add(intent)
            session.commit()
            return
        previous = intent.state
        intent.state = "sending" if intent.kind == "ready_email" else "ambiguous"
        intent.attempts += 1
        intent.due_at = now() + timedelta(seconds=120)
        session.add(intent)
        session.commit()  # Record mutation intent BEFORE SMTP/provider side effects.
        intent_id, kind = intent.id, intent.kind
        order = session.get(PaymentOrder, job.payment_id) if job.payment_id else None
        owner = session.get(User, job.user_id)
        email_allowed = owner and (owner.email or "").strip().casefold() == job.email
        expiry = svc.utc(job.expires_at) if job.expires_at else None
        title = json.loads(job.frozen_json)["title"]
        receipt = "vr_" + job.id.replace("-", "")
        payment_id = order.provider_payment_id if order else None
        amount = order.gross_amount_paise - order.refunded_amount_paise if order else 0
        target_email, job_id = job.email, job.id
    state, provider_id, error, refund_total = "pending", "", "", None
    try:
        if kind == "ready_email":
            if not email_allowed:
                state = "suppressed"
            else:
                local_expiry = expiry.astimezone(ZoneInfo(settings().timezone)).isoformat()
                get_email_sender().send(to_email=target_email, subject="Your Swico video is ready",
                    text_body=f"{title} is ready. Sign in to view it:\n{settings().origin}/?video={job_id}\n\nAvailable until {local_expiry} ({settings().timezone}). Download before expiry. No media is attached.",
                    message_id=f"<video-ready-{job_id}@swico.in>")
                state = "sent"
        elif not payment_id:
            state, error = "manual_review", "payment_identity_missing"
        else:
            client = RazorpayClient()
            refunds = client.fetch_payment_refunds(payment_id).get("items", [])
            matches = [r for r in refunds if r.get("receipt") == receipt]
            if matches:
                result = matches[0]
            elif previous == "pending":
                result = client.create_refund(payment_id, amount, receipt)
            else:
                # An absent GET result after an ambiguous POST is NOT proof it never ran.
                result = None
                state, error = "manual_review", "ambiguous_refund_requires_reconciliation"
            if result:
                if result.get("payment_id") != payment_id or result.get("currency") != "INR" or result.get("amount") != amount:
                    state, error = "manual_review", "refund_provider_mismatch"
                else:
                    provider_id = result.get("id", "")
                    state = {"processed": "processed", "failed": "failed", "pending": "submitted"}.get(result.get("status"), "manual_review")
                    if state == "processed":
                        refund_total = order.gross_amount_paise
    except Exception as exc:
        error = type(exc).__name__  # Never log provider bodies, photos, tokens, addresses.
        state = "pending" if kind == "ready_email" else "ambiguous"
    with SessionLocal() as session:
        intent = session.exec(select(VideoOutbox).where(VideoOutbox.id == intent_id).with_for_update()).one()
        # A webhook may have completed it while the POST was in flight.
        if intent.state == "processed":
            return
        intent.state, intent.provider_id, intent.error = state, provider_id, error
        if intent.attempts >= 4 and state in {"pending", "ambiguous"}:
            intent.state = "failed" if kind == "ready_email" else "manual_review"
        intent.due_at = now() + timedelta(seconds=min(120, 15 * 2 ** intent.attempts))
        session.add(intent)
        if refund_total is not None:
            job = session.get(VideoJob, job_id)
            order = session.exec(select(PaymentOrder).where(PaymentOrder.id == job.payment_id).with_for_update()).one()
            reverse_credit_for_refund(session, order, refund_total)
            metadata = json.loads(order.metadata_json or "{}")
            metadata["processed_refund_ids"] = sorted(set(metadata.get("processed_refund_ids", [])) | {provider_id})
            order.metadata_json = svc.encode(metadata)
            session.add(order)
        session.commit()


def _loop():
    while not _stop.wait(5):
        for operation in (sweep, deliver_one):
            try:
                operation()
            except Exception as exc:
                # Cache failure must not obstruct payment recovery or SMTP outboxes.
                log.warning("video_maintenance_unavailable operation=%s class=%s", operation.__name__, type(exc).__name__)


def start_maintenance():
    global _thread
    # Token presence keeps drain active when feature/checkout flags are disabled.
    try:
        configured = bool(settings().worker_digest)
    except (ValueError, KeyError):
        log.warning("video_configuration_invalid; ordinary chat remains available")
        return
    if not configured:
        try:
            with SessionLocal() as session:
                configured = session.exec(select(VideoJob.id).limit(1)).first() is not None
        except Exception:
            return
    if not configured or _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="video-maintenance", daemon=True)
    _thread.start()


def stop_maintenance():
    _stop.set()
    if _thread:
        _thread.join(timeout=2)
