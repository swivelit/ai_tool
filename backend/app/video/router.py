from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from datetime import timedelta
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session, select
from ..auth import AuthUser, get_current_user
from ..database import get_session
from ..models import PaymentOrder
from ..billing.razorpay_client import RazorpayClient
from . import service as svc
from .cache import cache
from .config import AUP_VERSION, TEMPLATE_IDS, settings
from .media import RAW_LIMIT, instructions, normalize_image, sha, validate_mp4
from .models import VideoJob, VideoTemplate, VideoControl, now

router = APIRouter(prefix="/api/web/videos", tags=["website videos"])
worker = APIRouter(prefix="/api/video-worker/v1", tags=["video worker"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Create(Strict):
    template_id: Literal["couple-01", "couple-02"]
    request_key: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    instructions: str = Field(default="swap: both\nenhance: off", max_length=300)
    consent: Literal[True]
    adult: Literal[True]
    policy_version: Literal["video-adult-consent-2026-09-18"]


class Admit(Strict):
    funding: Literal["complimentary", "paid"]


async def bounded_body(request: Request, limit: int) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise HTTPException(413, "Video upload limit exceeded")
        data.extend(chunk)
    return bytes(data)


def worker_auth(request: Request):
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    configured = settings().worker_digest
    if not configured or not hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), configured) or request.headers.get("x-worker-id") != "intel-mac-01":
        raise HTTPException(401, "Invalid video worker authentication")


def fenced(session: Session, request: Request, job_id: str) -> VideoJob:
    control = svc.control(session)
    job = session.exec(select(VideoJob).where(VideoJob.id == job_id).with_for_update()).first()
    if job is None:
        raise HTTPException(404, "Job not found")
    if (job.state not in {"preflighting", "processing"} or not job.lease_until or svc.utc(job.lease_until) <= now() or svc.utc(job.deadline) <= now()
            or not hmac.compare_digest(job.fence, request.headers.get("x-video-fence", ""))
            or request.headers.get("x-worker-boot") != control.worker_boot
            or str(job.attempt) != request.headers.get("x-video-attempt")):
        raise HTTPException(409, "Video lease lost; stop processing and delete local sources")
    return job


@router.get("/capabilities")
def capabilities(session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = svc.owner(session, auth)
    control = session.get(VideoControl, 1)
    templates = {t.id: t for t in session.exec(select(VideoTemplate)).all()}
    return {"enabled": settings().enabled, "paid_enabled": settings().paid,
            "available": bool(settings().enabled and svc.video_policy_ready() and control and svc.templates_current(session,control)),
            "price_paise": settings().price, "policy_version": AUP_VERSION, "allowance": svc.allowance(session, auth, user),
            "source_max_retention_seconds": settings().max_age, "output_ttl_seconds": settings().ttl,
            "templates": [{"id": key, "title": templates[key].title if key in templates else "Couple scene " + key[-1],
                           "available": bool(key in templates and control and svc.template_current(control,json.loads(templates[key].metadata_json))), "metadata": json.loads(templates[key].metadata_json) if key in templates else None} for key in TEMPLATE_IDS]}


@router.post("/jobs", status_code=201)
def create(payload: Create, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = svc.owner(session, auth)
    control = svc.admission(session)
    fingerprint = svc.digest(payload.model_dump())
    prior = session.exec(select(VideoJob).where(VideoJob.user_id == user.id, VideoJob.request_key == payload.request_key)).first()
    if prior:
        if prior.request_hash != fingerprint:
            raise HTTPException(409, "Request key reused with changed inputs")
        return svc.public_job(session, prior)
    outstanding = session.exec(select(VideoJob).where(VideoJob.user_id == user.id, VideoJob.state.not_in(svc.TERMINAL))).all()
    recent = session.exec(select(VideoJob.id).where(VideoJob.user_id == user.id, VideoJob.created_at > now() - timedelta(hours=1))).all()
    if outstanding or len(recent) >= 6:
        raise HTTPException(429, "One outstanding request and six photo preflights per hour are allowed")
    if len(session.exec(select(VideoJob.id).where(VideoJob.state.not_in(svc.TERMINAL))).all()) >= settings().capacity:
        raise HTTPException(429, "Video queue is full")
    template = session.get(VideoTemplate, payload.template_id)
    if template is None:
        raise HTTPException(409, "Template has not been approved and calibrated")
    if not svc.template_current(control,json.loads(template.metadata_json)):
        raise HTTPException(503, "Template calibration does not match the active worker profile")
    try:
        options = instructions(payload.instructions)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    frozen = {**json.loads(template.metadata_json), "consent": {"policy_version": AUP_VERSION, "adult": True, "face_rights": True, "accepted_at": now().isoformat()}}
    job = VideoJob(user_id=user.id, request_key=payload.request_key, request_hash=fingerprint, email=auth.email.strip().casefold(),
                   template_id=template.id, manifest_hash=template.manifest_hash, frozen_json=svc.encode(frozen),
                   options_json=svc.encode(options), deadline=now() + timedelta(seconds=600))
    try:
        cache().reserve(job.id, int(svc.utc(job.deadline).timestamp()))
    except Exception:
        raise HTTPException(503, "Video cache capacity unavailable; no payment taken") from None
    session.add(job)
    session.commit()
    return svc.public_job(session, job)


@router.put("/jobs/{job_id}/photos/{role}")
async def photo(job_id: str, role: Literal["male", "female"], request: Request, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = svc.owner(session, auth)
    raw = await bounded_body(request, RAW_LIMIT)
    try:
        data = normalize_image(raw)
    except Exception:
        raise HTTPException(422, "Use a single-frame JPEG, PNG or WebP photo, 64px minimum, at most 12 megapixels and 5 MiB") from None
    svc.control(session)
    job = svc.owned_job(session, user.id, job_id)
    if job.state != "uploading" or svc.utc(job.deadline) <= now():
        raise HTTPException(409, "Photo upload closed; create a new request")
    options = json.loads(job.options_json)
    if options["swap"] not in {"both", role}:
        raise HTTPException(422, "This role was not selected")
    inputs = json.loads(job.inputs_json)
    try:
        cache().put(job.id, role, data, int(svc.utc(job.deadline).timestamp()))
    except ValueError:
        raise HTTPException(409, "Photo changed; create a new preflight request") from None
    inputs[role] = sha(data)
    job.inputs_json = svc.encode(inputs)
    session.add(job)
    session.commit()
    return {"sha256": inputs[role], "normalized_bytes": len(data)}


@router.post("/jobs/{job_id}/preflight")
def preflight(job_id: str, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = svc.owner(session, auth)
    svc.admission(session)
    job = svc.owned_job(session, user.id, job_id)
    role = json.loads(job.options_json)["swap"]
    expected = {"male", "female"} if role == "both" else {role}
    if job.state != "uploading" or set(json.loads(job.inputs_json)) != expected or svc.utc(job.deadline) <= now():
        raise HTTPException(409, "Upload the selected role photos before validation")
    job.state, job.phase = "preflight_queued", "validation"
    session.add(job)
    session.commit()
    return svc.public_job(session, job)


@router.post("/jobs/{job_id}/admit")
def admit(job_id: str, payload: Admit, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = svc.owner(session, auth)
    control = svc.admission(session,templates_required=False)
    job = svc.owned_job(session, user.id, job_id)
    if job.state in svc.ACTIVE:
        if (payload.funding == "paid") != (job.funding == "paid"):
            raise HTTPException(409, "Funding choice changed")
        order = session.get(PaymentOrder, job.payment_id) if job.payment_id else None
        return {"job": svc.public_job(session, job), "checkout": checkout(order) if order and order.provider_order_id else None}
    if job.state != "validated" or svc.utc(job.deadline) <= now():
        raise HTTPException(409, "A current successful Mac preflight is required")
    template = session.get(VideoTemplate, job.template_id)
    if template.manifest_hash != job.manifest_hash or not svc.template_current(control,json.loads(job.frozen_json)):
        raise HTTPException(409, "Template changed; repeat validation")
    if not svc.templates_current(session,control):
        raise HTTPException(503,"Worker template metadata stale; no payment taken")
    if payload.funding == "paid" and not settings().paid:
        raise HTTPException(503, "Paid video checkout is disabled")
    if payload.funding == "complimentary":
        svc.reserve_allowance(session, job, auth, user)
    deadline = now() + timedelta(seconds=settings().max_age)
    try:
        cache().reserve(job.id, int(deadline.timestamp()))
        cache().pin(job.id, list(json.loads(job.inputs_json)), int(deadline.timestamp()))
    except Exception:
        raise HTTPException(503, "Sources/cache unavailable; repeat preflight. No payment taken.") from None
    job.deadline, job.admitted_at = deadline, now()
    if payload.funding == "complimentary":
        job.state, job.phase = "queued", "queued"
        svc.chat_card(session, job)
        session.add(job)
        session.commit()
        return {"job": svc.public_job(session, job), "checkout": None}
    order = PaymentOrder(user_id=user.id, receipt="vid_" + job.id.replace("-", ""), purchase_type="video_template",
                         credit_bucket=None, gross_amount_paise=2500, credited_amount_micros=0, platform_share_paise=0)
    session.add(order)
    session.flush()
    job.payment_id, job.funding, job.state, job.phase = order.id, "paid", "checkout", "checkout"
    session.add(job)
    session.commit()  # Durable order/hold precedes side effect; never auto-retry ambiguous POST.
    try:
        provider = RazorpayClient().create_order(2500, order.receipt)
        if provider.get("amount") != 2500 or provider.get("currency") != "INR" or not provider.get("id"):
            raise ValueError("provider_order_mismatch")
    except Exception:
        # Unknown creation requires operator reconciliation, not blind POST retry.
        order.status = "failed"
        svc.fail(session, job, "checkout_creation_unknown")
        session.add(order)
        session.commit()
        raise HTTPException(502, "Checkout could not be confirmed. No retry was charged; contact support if payment occurred.") from None
    order.provider_order_id, order.status = provider["id"], "created"
    session.add(order)
    session.commit()
    return {"job": svc.public_job(session, job), "checkout": checkout(order)}


def checkout(order):
    import os
    return {"key_id": os.getenv("RAZORPAY_KEY_ID", ""), "provider_order_id": order.provider_order_id,
            "internal_order_id": order.id, "amount": 2500, "currency": "INR", "purchase_type": "video_template"}


@router.get("/jobs")
def jobs(session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = svc.owner(session, auth)
    return {"items": [svc.public_job(session, job) for job in session.exec(select(VideoJob).where(VideoJob.user_id == user.id).order_by(VideoJob.created_at.desc()).limit(30)).all()]}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    return svc.public_job(session, svc.owned_job(session, svc.owner(session, auth).id, job_id))


@router.post("/jobs/{job_id}/cancel")
def cancel(job_id: str, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    user = svc.owner(session, auth)
    svc.control(session)
    job = svc.owned_job(session, user.id, job_id)
    if job.state not in svc.TERMINAL:
        svc.fail(session, job, "owner_cancelled", infrastructure=False, cancelled=True)
        session.commit()
        cache().delete(job.id)
    return svc.public_job(session, job)


@router.get("/jobs/{job_id}/media")
def media(job_id: str, request: Request, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    job = svc.owned_job(session, svc.owner(session, auth).id, job_id)
    headers = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": f'attachment; filename="swico-{job.id}.mp4"'}
    if job.expires_at and svc.utc(job.expires_at) <= now() or job.state == "expired":
        raise HTTPException(410, "Video expired", headers=headers)
    if job.state != "ready":
        raise HTTPException(409, "Video is not ready", headers=headers)
    try:
        data = cache().get(job.id, "output")
    except Exception:
        raise HTTPException(503, "Temporary video storage outage; try again before the displayed expiry", headers=headers) from None
    if data is None or sha(data) != job.output_hash:
        svc.fail(session, job, "artifact_lost_before_expiry")
        session.commit()
        raise HTTPException(503, "Video unavailable; non-delivery recovery/refund initiated", headers=headers)
    span = request.headers.get("range")
    if span:
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", span)
        if not match:
            raise HTTPException(416, "Unsupported range", headers=headers)
        start, end = int(match[1]), int(match[2]) if match[2] else len(data) - 1
        if not 0 <= start <= end < len(data):
            raise HTTPException(416, "Invalid range", headers=headers)
        headers["Content-Range"] = f"bytes {start}-{end}/{len(data)}"
        return Response(data[start:end+1], status_code=206, media_type="video/mp4", headers=headers)
    return Response(data, media_type="video/mp4", headers=headers)


class Register(Strict):
    boot_id: str = Field(min_length=16, max_length=64)
    ready: bool
    native_inference_verified: bool
    revision: str = Field(max_length=64)
    profile_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    disk_free_bytes: int = Field(ge=0)
    calibration_schema: Literal[2]
    runtime_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    calibrations: dict[str,str] = Field(max_length=2)


@worker.get("/health", dependencies=[Depends(worker_auth)])
def worker_health(session: Session = Depends(get_session)):
    from sqlalchemy import inspect
    schema=all(inspect(session.get_bind()).has_table(t) for t in ("video_control","video_template","video_job","video_quota","video_outbox"))
    row = session.get(VideoControl, 1) if schema else None
    return {"authenticated": True, "schema_ready": schema, "control_initialized":row is not None,
            "worker_active": bool(row and svc.healthy(row)),"templates_current":bool(schema and row and svc.templates_current(session,row))}


@worker.post("/heartbeat", dependencies=[Depends(worker_auth)])
def worker_heartbeat(payload: Register, session: Session = Depends(get_session)):
    if payload.ready and (set(payload.calibrations)!=set(TEMPLATE_IDS) or any(not re.fullmatch(r"[a-f0-9]{64}",v) for v in payload.calibrations.values())):
        raise HTTPException(422,"Current calibration identity required for both templates")
    row = svc.control(session)
    if row.worker_boot and row.worker_boot != payload.boot_id and row.worker_seen_at and (now() - svc.utc(row.worker_seen_at)).total_seconds() < settings().stale:
        raise HTTPException(409, "Another video worker instance is active")
    row.worker_boot, row.worker_seen_at, row.capabilities_json = payload.boot_id, now(), svc.encode(payload.model_dump())
    session.add(row)
    session.commit()
    return {"ok": True}


class Publish(Strict):
    id: Literal["couple-01", "couple-02"]
    title: str = Field(min_length=1, max_length=80)
    template_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    tracks_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    profile_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    rights_evidence_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    qa_evidence_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    warm_seconds: list[float] = Field(min_length=6, max_length=60)
    cold_seconds: list[float] = Field(min_length=2, max_length=2)
    startup_seconds: float = Field(gt=0, le=600)
    duration_seconds: float = Field(ge=1, le=30)
    width: int = Field(ge=64, le=1920)
    height: int = Field(ge=64, le=1920)
    profile: Literal["quality-cpu"]
    calibration_schema: Literal[2]
    runtime_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


@worker.post("/templates", dependencies=[Depends(worker_auth)])
def publish(payload: Publish, session: Session = Depends(get_session)):
    svc.control(session)
    import math
    if any(not math.isfinite(x) or not 0 < x or (x + payload.startup_seconds)*1.3 > (settings().max_age-600) / settings().capacity for x in [*payload.warm_seconds, *payload.cold_seconds]):
        raise HTTPException(422, "Calibration exceeds bounded queue deadline")
    metadata = payload.model_dump()
    template = session.get(VideoTemplate, payload.id) or VideoTemplate(id=payload.id, title=payload.title, manifest_hash="", metadata_json="{}")
    template.title, template.metadata_json, template.manifest_hash = payload.title, svc.encode(metadata), svc.digest(metadata)
    template.published_at = now()
    session.add(template)
    session.commit()
    return {"manifest_hash": template.manifest_hash}


@worker.post("/claim", dependencies=[Depends(worker_auth)])
def claim(request: Request, session: Session = Depends(get_session)):
    row = svc.control(session)
    if not svc.healthy(row) or request.headers.get("x-worker-boot") != row.worker_boot:
        raise HTTPException(409, "Worker registration not current")
    running = session.exec(select(VideoJob).where(VideoJob.state.in_({"preflighting", "processing"}))).first()
    if running:
        return {"job": None}
    job = session.exec(select(VideoJob).where(VideoJob.state == "queued", VideoJob.deadline > now()).order_by(VideoJob.admitted_at).with_for_update(skip_locked=True)).first()
    if job is None:
        job = session.exec(select(VideoJob).where(VideoJob.state == "preflight_queued", VideoJob.deadline > now()).order_by(VideoJob.created_at).with_for_update(skip_locked=True)).first()
    if job is None:
        return {"job": None}
    if not svc.template_current(row,json.loads(job.frozen_json)):
        svc.fail(session,job,"template_changed")
        session.commit()
        return {"job":None}  # Restore/refund safely, never render stale profile.
    job.attempt += 1
    job.fence, job.lease_until = secrets.token_hex(32), now() + timedelta(seconds=45)
    job.state = "processing" if job.state == "queued" else "preflighting"
    if job.state == "processing":
        job.started_at = job.started_at or now()
        if job.quota_state == "reserved":
            job.quota_state = "consumed"
    session.add(job)
    session.commit()
    return {"job": {"id": job.id, "state": job.state, "attempt": job.attempt, "fence": job.fence,
                    "deadline": svc.utc(job.deadline).isoformat(), "template": json.loads(job.frozen_json),
                    "options": json.loads(job.options_json), "inputs": json.loads(job.inputs_json)}}


class Progress(Strict):
    phase: Literal["validation", "decode", "swap", "encode", "upload"]
    percent: int = Field(ge=0, le=99)


@worker.post("/jobs/{job_id}/heartbeat", dependencies=[Depends(worker_auth)])
def progress(job_id: str, payload: Progress, request: Request, session: Session = Depends(get_session)):
    job = fenced(session, request, job_id)
    job.lease_until, job.phase, job.progress = now() + timedelta(seconds=45), payload.phase, max(job.progress, payload.percent)
    session.add(job)
    session.commit()
    return {"ok": True}


@worker.get("/jobs/{job_id}/inputs/{role}", dependencies=[Depends(worker_auth)])
def inputs(job_id: str, role: Literal["male", "female"], request: Request, session: Session = Depends(get_session)):
    job = fenced(session, request, job_id)
    data = cache().get(job.id, role)
    if data is None or sha(data) != json.loads(job.inputs_json).get(role):
        raise HTTPException(410, "Input unavailable")
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


class Finish(Strict):
    outcome: Literal["valid", "invalid", "failed", "ready"]
    reason: Literal["", "source_face_count", "source_quality", "safety_rejected", "caption_unsupported", "template_changed", "render_failed"] = ""
    sha256: str = Field(default="", max_length=64)


@worker.put("/jobs/{job_id}/output", dependencies=[Depends(worker_auth)])
async def output(job_id: str, request: Request, session: Session = Depends(get_session)):
    data = await bounded_body(request, settings().max_output)
    job = fenced(session, request, job_id)
    if job.state != "processing":
        raise HTTPException(409, "Not a render attempt")
    try:
        validate_mp4(data)
        cache().put(job.id, "output", data, int(svc.utc(job.deadline).timestamp()))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    job.output_hash, job.output_size = sha(data), len(data)
    session.add(job)
    session.commit()
    return {"sha256": job.output_hash, "bytes": job.output_size}


@worker.post("/jobs/{job_id}/complete", dependencies=[Depends(worker_auth)])
def complete(job_id: str, payload: Finish, request: Request, session: Session = Depends(get_session)):
    svc.control(session)
    # Acknowledgement lost after commit: return same immutable READY, never renew TTL.
    existing = session.get(VideoJob, job_id)
    if existing and existing.state == "ready" and payload.outcome == "ready" and payload.sha256 == existing.output_hash and hmac.compare_digest(existing.fence, request.headers.get("x-video-fence", "")) and str(existing.attempt) == request.headers.get("x-video-attempt"):
        return svc.public_job(session, existing)
    job = fenced(session, request, job_id)
    if payload.outcome == "valid" and job.state == "preflighting":
        job.state, job.phase, job.lease_until = "validated", "confirm", None
    elif payload.outcome == "ready" and job.state == "processing":
        data = cache().get(job.id, "output")
        if not data or sha(data) != payload.sha256 or payload.sha256 != job.output_hash:
            raise HTTPException(409, "Complete verified upload before finalization")
        job.ready_at = now()
        job.expires_at = job.ready_at + timedelta(seconds=600)
        cache().expire_output(job.id, int(job.expires_at.timestamp()))
        job.state, job.phase, job.progress, job.lease_until = "ready", "ready", 100, None
        svc.outbox(session, job, "ready_email")
        svc.chat_card(session, job)
    elif payload.outcome in {"invalid", "failed"}:
        svc.fail(session, job, payload.reason or "render_failed")
    else:
        raise HTTPException(409, "Invalid completion transition")
    session.add(job)
    session.commit()
    if job.state in svc.TERMINAL:
        cache().delete_sources(job.id)
    return svc.public_job(session, job)
