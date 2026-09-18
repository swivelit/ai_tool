from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from fastapi import HTTPException
from sqlmodel import Session, select
from ..auth import AuthUser, get_owned_user, is_weekly_tester_user
from ..models import PaymentOrder, WebChatMessage, WebChatThread
from .config import settings
from .policy import video_policy_ready
from .models import VideoControl, VideoJob, VideoOutbox, VideoQuota, VideoTemplate, now

TERMINAL = {"ready", "expired", "failed", "cancelled", "refund_pending", "refunded"}
ACTIVE = {"checkout", "queued", "processing"}


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def encode(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def digest(value) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


def owner(session: Session, auth: AuthUser):
    user = get_owned_user(session, auth)
    if not auth.email_verified or not auth.email or auth.email.strip().casefold() != (user.email or "").strip().casefold():
        raise HTTPException(403, "A verified email belonging to this account is required.")
    return user


def control(session: Session) -> VideoControl:
    # Singleton serializes only short video admission/state transactions. No network IO here.
    row = session.exec(select(VideoControl).where(VideoControl.id == 1).with_for_update()).first()
    if row is None:
        raise HTTPException(503, "Video migration is required")
    return row


def healthy(row: VideoControl) -> bool:
    caps = json.loads(row.capabilities_json)
    return bool(row.worker_seen_at and (now() - utc(row.worker_seen_at)).total_seconds() <= settings().stale
                and caps.get("ready") is True and caps.get("native_inference_verified") is True)


def admission(session: Session) -> VideoControl:
    row = control(session)
    if not settings().enabled or not healthy(row):
        raise HTTPException(503, "Video admission paused: verified worker unavailable")
    if not video_policy_ready():
        raise HTTPException(503, "Video admission paused: current video policy publication approval required")
    return row


def owned_job(session: Session, user_id: int, job_id: str) -> VideoJob:
    job = session.exec(select(VideoJob).where(VideoJob.id == job_id, VideoJob.user_id == user_id).with_for_update()).first()
    if job is None:
        raise HTTPException(404, "Video not found")
    return job


def day_window():
    local = now().astimezone(ZoneInfo(settings().timezone))
    tomorrow = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return local.date().isoformat(), tomorrow.astimezone(timezone.utc)


def allowance(session: Session, auth: AuthUser, user) -> dict:
    day, reset = day_window()
    unlimited = auth.email.strip().casefold() in settings().unlimited
    tester = is_weekly_tester_user(auth, user)
    quota = session.exec(select(VideoQuota).where(VideoQuota.user_id == user.id, VideoQuota.day == day)).first()
    return {"unlimited": unlimited, "remaining": None if unlimited else max(0, settings().daily - (quota.used if quota else 0)) if tester else 0,
            "tester": tester, "reset_at": reset.isoformat()}


def reserve_allowance(session: Session, job: VideoJob, auth: AuthUser, user) -> None:
    info = allowance(session, auth, user)
    if info["unlimited"]:
        job.funding = "unlimited"
        return
    if not info["remaining"]:
        raise HTTPException(409, "No complimentary attempts remain; paid checkout requires a separate explicit choice.")
    day, _ = day_window()
    quota = session.exec(select(VideoQuota).where(VideoQuota.user_id == user.id, VideoQuota.day == day).with_for_update()).first()
    if quota is None:
        quota = VideoQuota(user_id=user.id, day=day)
    quota.used += 1
    session.add(quota)
    session.flush()
    job.quota_id, job.quota_state, job.funding = quota.id, "reserved", "tester"


def restore_allowance(session: Session, job: VideoJob, *, infrastructure: bool) -> None:
    if job.quota_id and (job.quota_state == "reserved" or infrastructure and job.quota_state == "consumed"):
        quota = session.exec(select(VideoQuota).where(VideoQuota.id == job.quota_id).with_for_update()).one()
        quota.used = max(0, quota.used - 1)
        job.quota_state = "restored"
        session.add(quota)


def outbox(session: Session, job: VideoJob, kind: str):
    row = session.exec(select(VideoOutbox).where(VideoOutbox.job_id == job.id, VideoOutbox.kind == kind)).first()
    if row is None:
        row = VideoOutbox(job_id=job.id, kind=kind)
        session.add(row)
    return row


def fail(session: Session, job: VideoJob, reason: str, *, infrastructure=True, cancelled=False):
    if job.state in {"refunded", "expired"}:
        return
    job.error = reason
    job.state = "cancelled" if cancelled else "failed"
    job.lease_until, job.fence = None, ""
    restore_allowance(session, job, infrastructure=infrastructure)
    if job.payment_id:
        order = session.get(PaymentOrder, job.payment_id)
        if order and order.provider_payment_id and not order.refunded_amount_paise:
            job.state = "refund_pending"
            outbox(session, job, "refund")
    session.add(job)


def chat_card(session: Session, job: VideoJob):
    if job.thread_id:
        return
    template = json.loads(job.frozen_json)
    thread = WebChatThread(user_id=job.user_id, title="Video · " + template["title"])
    session.add(thread)
    session.flush()
    job.thread_id = thread.id
    session.add(WebChatMessage(thread_id=thread.id, user_id=job.user_id, role="assistant", content="Your AI-edited video",
                               request_id="video-" + job.id, status="complete", metadata_json=encode({"video": {"job_id": job.id, "version": 1}})))
    session.add(job)


def fulfill_video(session: Session, order: PaymentOrder):
    # Called by BOTH existing checkout verification and shared signed webhook.
    if order.gross_amount_paise != 2500 or order.credited_amount_micros != 0 or order.credit_bucket is not None:
        raise ValueError("Invalid video payment product")
    job = session.exec(select(VideoJob).where(VideoJob.payment_id == order.id).with_for_update()).one()
    if not order.provider_payment_id:
        raise ValueError("Captured video payment ID is required")
    order.paid_at = order.paid_at or now()
    if order.refunded_amount_paise or job.state in TERMINAL:
        if job.state not in {"ready", "expired", "refunded"} and order.provider_payment_id and not order.refunded_amount_paise:
            job.state = "refund_pending"
            outbox(session, job, "refund")
            order.status, order.fulfillment_status = "fulfilled", "fulfilled"
            session.add(job)
        session.add(order)
        return job
    if job.state == "checkout":
        from .cache import cache
        try:
            if utc(job.deadline) <= now() or not job.admitted_at or (now()-utc(job.admitted_at)).total_seconds() > 300:
                raise ValueError("expired")
            cache().pin(job.id, list(json.loads(job.inputs_json)), int(utc(job.deadline).timestamp()))
        except Exception:
            fail(session, job, "capture_after_source_expiry")
        else:
            job.state = "queued"
            chat_card(session, job)
    order.status, order.fulfillment_status = "fulfilled", "fulfilled"
    session.add(order)
    session.add(job)
    return job


def video_refund(session: Session, order: PaymentOrder, total: int) -> int:
    order.refunded_amount_paise = max(order.refunded_amount_paise, min(total, order.gross_amount_paise))
    order.status = "refunded" if order.refunded_amount_paise == order.gross_amount_paise else "partially_refunded"
    order.updated_at = now()
    if order.status == "refunded":
        order.refunded_at = now()
    job = session.exec(select(VideoJob).where(VideoJob.payment_id == order.id).with_for_update()).one()
    job.state, job.fence, job.lease_until = "refunded" if order.status == "refunded" else "refund_pending", "", None
    intent = outbox(session, job, "refund")
    intent.state = "processed" if order.status == "refunded" else "manual_review"
    session.add(intent)
    session.add(job)
    session.add(order)
    return 0


def public_job(session: Session, job: VideoJob) -> dict:
    state = "expired" if job.expires_at and utc(job.expires_at) <= now() else job.state
    row = session.get(VideoControl, 1)
    ahead = session.exec(select(VideoJob).where(VideoJob.state.in_({"queued", "processing"}), VideoJob.admitted_at < job.admitted_at).order_by(VideoJob.admitted_at)).all() if job.admitted_at else []
    durations = []
    for item in [*ahead, job]:
        metadata = json.loads(item.frozen_json)
        values = [x + metadata.get("startup_seconds", 0) for x in [*metadata.get("warm_seconds", []), *metadata.get("cold_seconds", [])]]
        if values:
            remaining = (now() - utc(item.started_at)).total_seconds() if item.started_at else 0
            durations.append((max(0, min(values) - remaining), max(0, max(values) * 1.3 - remaining)))
    refund = session.exec(select(VideoOutbox).where(VideoOutbox.job_id == job.id, VideoOutbox.kind == "refund")).first()
    email = session.exec(select(VideoOutbox).where(VideoOutbox.job_id == job.id, VideoOutbox.kind == "ready_email")).first()
    return {"id": job.id, "template_id": job.template_id, "state": state, "phase": job.phase, "progress": job.progress,
            "error": job.error, "funding": job.funding, "thread_id": job.thread_id, "options": json.loads(job.options_json),
            "queue_position": len(ahead) + 1 if job.state == "queued" else None,
            "eta_seconds": [round(sum(x[i] for x in durations)) for i in (0, 1)] if durations and row and healthy(row) and job.state in {"queued", "processing"} else None,
            "eta_confidence": "calibrated_range_not_SLA" if durations else "calibrating", "paused": not (row and healthy(row)),
            "expires_at": utc(job.expires_at).isoformat() if job.expires_at else None,
            "refund_status": refund.state if refund else None, "notification_status": email.state if email else None}
