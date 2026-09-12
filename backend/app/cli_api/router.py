from __future__ import annotations

import asyncio
from datetime import timedelta
import hashlib
import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from ..auth import AuthUser, firebase_cli_session_is_active, get_current_user, get_owned_user
from ..billing.errors import RateLimitError
from ..billing.service import enforce_rate_limit, get_wallet_summary, release_swico_free_usage
from ..database import SessionLocal, get_session
from ..models import (
    CliAgentRun, CliAgentStep, CliDeviceGrant, CliPendingAction, CliSession,
    User, WebChatThread,
)
from ..time_utils import ensure_utc, utc_now
from ..web_api.chat_service import (
    AttachmentRequestError, DuplicateRequestInProgress, PromptBudgetExceeded,
    execute_web_turn, prepare_web_turn, record_web_turn_lifecycle,
)
from ..web_api.router import SwicoFreeLimitError, _enforce_swico_free_limits
from ..web_api.swico_free_access import swico_free_eligible
from ..web_api.usage_service import selected_swico_tier
from ..ai.swico_tiers import (
    SWICO_TIER_LABELS, SwicoTierUnavailableError, normalize_swico_tier,
    pro_enabled, public_tier_settings,
)
from .config import CliConfigurationError, agent_step_ceiling, cli_settings
from .contracts import (
    AgentAction, AgentResultRequest, AgentRunRequest, CliChatRequest,
    AgentPlanRequest, CliTierRequest, DeviceApprovalRequest, DeviceAuthorizationRequest,
    DeviceTokenRequest,
)
from .security import (
    digest, human_code, random_secret, valid_code_challenge,
    valid_code_verifier, verify_code_challenge,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/cli/v1", tags=["cli"])
_BLOCKED_AGENT_PATH = re.compile(
    r"(?:^|/)\.env(?:$|[./])|(?:^|/)(?:\.npmrc|\.pypirc|\.ssh|credentials?|secrets?|tokens?|node_modules|dist|build|\.git)(?:/|$)|\.(?:pem|key|p12|pfx|kdbx)$",
    re.I,
)


def _settings():
    try:
        return cli_settings()
    except CliConfigurationError as exc:
        raise HTTPException(503, {"code": "cli_configuration_invalid", "message": str(exc)}) from exc


def _require_enabled():
    settings = _settings()
    if not settings.enabled:
        raise HTTPException(404, {"code": "cli_disabled", "message": "Swico CLI is not enabled."})
    return settings


def _require_agent_enabled():
    settings = _require_enabled()
    if not settings.agent_enabled:
        raise HTTPException(404, {"code": "cli_agent_disabled", "message": "The local coding agent is not enabled."})
    return settings


def _grant_error(code: str, description: str, status: int = 400):
    raise HTTPException(status, {"error": code, "error_description": description})


def _scope_list(raw: str) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        value = []
    return [str(item) for item in value if str(item) in {"chat", "agent"}]


def _canonical_payload_hash(payload: dict[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def _safe_agent_path(value: object, *, max_length: int = 512) -> bool:
    if not isinstance(value, str) or not value or len(value) > max_length:
        return False
    normalized = value.replace("\\", "/")
    return not normalized.startswith(("/", "~", "//")) and ".." not in normalized.split("/") and not _BLOCKED_AGENT_PATH.search(normalized)


def _validate_agent_action_payload(action: AgentAction) -> str:
    """Validate the complete action before it is admitted for local execution.

    The payload is intentionally validated in memory and only its hash is
    retained in durable state; source text and patches do not belong in the
    server's recovery records.
    """
    payload = action.payload
    if not isinstance(payload, dict):
        raise HTTPException(422, "Structured actions must include a payload.")
    if action.action_type == "list_files":
        limit = payload.get("limit", 200)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 500:
            raise HTTPException(422, "list_files limit is outside the supported bound.")
    elif action.action_type == "search_text":
        term = payload.get("term")
        if not isinstance(term, str) or not term.strip() or len(term) > 512:
            raise HTTPException(422, "search_text requires bounded search text.")
    elif action.action_type == "read_file":
        path = payload.get("path")
        if not _safe_agent_path(path):
            raise HTTPException(422, "read_file path is invalid.")
    elif action.action_type == "read_file_range":
        path, start, end = payload.get("path"), payload.get("start", 1), payload.get("end", 1)
        if (
            not _safe_agent_path(path)
            or not isinstance(start, int) or isinstance(start, bool)
            or not isinstance(end, int) or isinstance(end, bool)
            or start < 1 or end < start or end - start > 2_000
        ):
            raise HTTPException(422, "read_file_range payload is invalid.")
    elif action.action_type == "apply_patch":
        path = payload.get("path")
        expected = payload.get("expected_sha256")
        content = payload.get("patch", payload.get("content"))
        if (
            not _safe_agent_path(path)
            or not isinstance(expected, str) or len(expected) != 64
            or any(char not in "0123456789abcdefABCDEF" for char in expected)
            or not isinstance(content, str) or len(content.encode()) > 256 * 1024
        ):
            raise HTTPException(422, "apply_patch payload is invalid or too large.")
    elif action.action_type == "create_file":
        path, content = payload.get("path"), payload.get("content")
        if (
            not _safe_agent_path(path)
            or not isinstance(content, str) or len(content.encode()) > 256 * 1024
        ):
            raise HTTPException(422, "create_file payload is invalid or too large.")
    elif action.action_type == "delete_file":
        path = payload.get("path")
        if not _safe_agent_path(path):
            raise HTTPException(422, "delete_file path is invalid.")
    elif action.action_type == "move_file":
        source, target = payload.get("from"), payload.get("to")
        if not _safe_agent_path(source) or not _safe_agent_path(target):
            raise HTTPException(422, "move_file paths are invalid.")
    elif action.action_type == "run_command":
        argv = payload.get("argv")
        timeout = payload.get("timeout_ms", 30_000)
        if (
            not isinstance(argv, list) or not argv or len(argv) > 32
            or any(not isinstance(value, str) or not value or len(value) > 512 for value in argv)
            or not isinstance(timeout, int) or isinstance(timeout, bool)
            or not 100 <= timeout <= 120_000
        ):
            raise HTTPException(422, "run_command payload is invalid or outside the supported bound.")
    elif action.action_type == "git_diff":
        ref = payload.get("ref")
        if ref is not None and (not isinstance(ref, str) or len(ref) > 256 or any(char in ref for char in "\x00\r\n")):
            raise HTTPException(422, "git_diff ref is invalid.")
    calculated = _canonical_payload_hash(payload)
    if action.payload_hash is not None and action.payload_hash != calculated:
        raise HTTPException(422, "Action payload hash is invalid.")
    return calculated


def _email_allowed(settings, auth: AuthUser, user: User) -> bool:
    email = str(auth.email or "").strip().casefold()
    return bool(
        auth.email_verified and email and email == str(user.email or "").strip().casefold()
        and (not settings.allowed_emails or email in settings.allowed_emails)
    )


def _issue_session(session: Session, grant: CliDeviceGrant, user: User, settings) -> tuple[str, str, CliSession]:
    now = utc_now()
    access, refresh = random_secret(32), random_secret(48)
    selected = selected_swico_tier(session, int(user.id))
    if selected == "free" and not swico_free_eligible(int(user.id)):
        selected = "lite"
    scopes = _scope_list(grant.scopes_json)
    if "agent" in scopes and (not settings.agent_enabled or selected == "free"):
        scopes = [item for item in scopes if item != "agent"]
    row = CliSession(
        user_id=int(user.id), client_id=grant.client_id,
        access_token_digest=digest(access),
        access_expires_at=now + timedelta(seconds=settings.access_token_seconds),
        refresh_token_digest=digest(refresh),
        refresh_expires_at=now + timedelta(seconds=settings.session_max_seconds),
        max_expires_at=now + timedelta(seconds=settings.session_max_seconds),
        selected_tier=selected, scopes_json=json.dumps(scopes, separators=(",", ":")),
        device_description=grant.device_description,
    )
    session.add(row)
    return access, refresh, row


def _token_response(access: str, refresh: str, row: CliSession, user: User) -> dict[str, Any]:
    return {
        "access_token": access, "refresh_token": refresh, "token_type": "Bearer",
        "expires_in": max(0, int((ensure_utc(row.access_expires_at) - utc_now()).total_seconds())),
        "session_id": row.id, "tier": row.selected_tier,
        "tier_label": SWICO_TIER_LABELS.get(row.selected_tier, "Swico"),
        "scopes": _scope_list(row.scopes_json),
        "account": {"email": user.email, "name": user.name},
    }


def _cli_session_from_header(
    authorization: str | None,
    session: Session,
    *,
    required_scope: str = "chat",
    allow_disabled: bool = False,
) -> tuple[CliSession, User]:
    settings = _settings()
    if not settings.enabled and not allow_disabled:
        raise HTTPException(404, {"code": "cli_disabled", "message": "Swico CLI is not enabled."})
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing CLI access token")
    raw = authorization[7:].strip()
    row = session.exec(select(CliSession).where(CliSession.access_token_digest == digest(raw)).with_for_update()).first()
    now = utc_now()
    if row is None or row.revoked_at is not None or ensure_utc(row.access_expires_at) <= now or ensure_utc(row.max_expires_at) <= now:
        raise HTTPException(401, "CLI access token is expired or revoked")
    user = session.get(User, row.user_id)
    if user is None:
        if row is not None:
            row.revoked_at, row.revoke_reason = now, "account_missing"
            session.add(row)
        raise HTTPException(401, "CLI account is unavailable")
    if not firebase_cli_session_is_active(user.firebase_uid or "", user.email, row.created_at):
        row.revoked_at, row.revoke_reason = now, "firebase_identity_changed"
        session.add(row)
        raise HTTPException(401, "CLI account authorization is no longer active")
    if required_scope not in _scope_list(row.scopes_json):
        raise HTTPException(403, "CLI session lacks the required scope")
    row.last_seen_at = now
    session.add(row)
    return row, user


@router.post("/device")
def create_device_grant(payload: DeviceAuthorizationRequest, session: Session = Depends(get_session)):
    settings = _require_enabled()
    if not valid_code_challenge(payload.code_challenge):
        _grant_error("invalid_request", "code_challenge must be an RFC 7636 S256 challenge")
    if "agent" in payload.scopes and not settings.agent_enabled:
        _grant_error("invalid_scope", "The agent scope is not enabled.")
    if payload.client_id != "swico-cli":
        _grant_error("invalid_client", "Unknown CLI client.")
    now = utc_now()
    recent = session.exec(select(CliDeviceGrant).where(
        CliDeviceGrant.client_id == payload.client_id,
        CliDeviceGrant.created_at >= now - timedelta(minutes=1),
    )).all()
    if len(recent) >= 10:
        raise HTTPException(429, {"error": "slow_down", "error_description": "Too many device requests."})
    raw_device, code = random_secret(32), human_code()
    grant = CliDeviceGrant(
        client_id=payload.client_id, device_code_digest=digest(raw_device),
        user_code_digest=digest(code), code_challenge=payload.code_challenge,
        device_description=payload.device_description.strip(),
        scopes_json=json.dumps(sorted(set(payload.scopes)), separators=(",", ":")),
        expires_at=now + timedelta(seconds=settings.device_grant_seconds),
        interval_seconds=settings.poll_interval_seconds,
    )
    session.add(grant)
    session.commit()
    return {
        "device_code": raw_device, "user_code": code,
        "verification_uri": f"{settings.web_origin}/cli/authorize",
        "verification_uri_complete": f"{settings.web_origin}/cli/authorize?user_code={code}",
        "expires_in": settings.device_grant_seconds, "interval": settings.poll_interval_seconds,
    }


@router.get("/device/{user_code}")
def device_info(user_code: str, session: Session = Depends(get_session)):
    _require_enabled()
    grant = session.exec(select(CliDeviceGrant).where(CliDeviceGrant.user_code_digest == digest(user_code.strip().upper()))).first()
    if grant is None or ensure_utc(grant.expires_at) <= utc_now() or grant.status in {"consumed", "expired"}:
        raise HTTPException(404, "Device request not found or expired")
    return {"user_code": user_code.strip().upper(), "device_description": grant.device_description, "scopes": _scope_list(grant.scopes_json), "status": grant.status, "expires_at": grant.expires_at.isoformat()}


@router.post("/device/approve")
def approve_device(payload: DeviceApprovalRequest, session: Session = Depends(get_session), auth: AuthUser = Depends(get_current_user)):
    settings = _require_enabled()
    user = get_owned_user(session, auth)
    if not _email_allowed(settings, auth, user):
        raise HTTPException(403, "A verified account email is required for CLI access.")
    grant = session.exec(select(CliDeviceGrant).where(CliDeviceGrant.user_code_digest == digest(payload.user_code.strip().upper())).with_for_update()).first()
    if grant is None or ensure_utc(grant.expires_at) <= utc_now():
        raise HTTPException(404, "Device request not found or expired")
    if grant.status != "pending":
        raise HTTPException(409, "Device request has already been decided")
    grant.user_attempt_count += 1
    grant.last_user_attempt_at = utc_now()
    if grant.user_attempt_count > 5:
        grant.status = "expired"
        session.add(grant)
        raise HTTPException(429, "Too many approval attempts")
    grant.status, grant.approved_user_id = ("approved", int(user.id)) if payload.approved else ("denied", None)
    session.add(grant)
    session.commit()
    return {"status": grant.status}


@router.post("/token")
def token(payload: DeviceTokenRequest, session: Session = Depends(get_session)):
    settings = _require_enabled()
    now = utc_now()
    if payload.grant_type == "refresh_token":
        if not payload.refresh_token:
            _grant_error("invalid_request", "refresh_token is required")
        row = session.exec(select(CliSession).where(CliSession.refresh_token_digest == digest(payload.refresh_token)).with_for_update()).first()
        if row is None:
            reused = session.exec(select(CliSession).where(CliSession.previous_refresh_token_digest == digest(payload.refresh_token)).with_for_update()).first()
            if reused is not None:
                reused.revoked_at, reused.revoke_reason = now, "refresh_reuse"
                session.add(reused); session.commit()
            _grant_error("invalid_grant", "Refresh token is expired, reused, or revoked")
        if row.revoked_at is not None or ensure_utc(row.refresh_expires_at) <= now or ensure_utc(row.max_expires_at) <= now:
            _grant_error("invalid_grant", "Refresh token is expired, reused, or revoked")
        user = session.get(User, row.user_id)
        if user is None:
            row.revoked_at, row.revoke_reason = now, "account_missing"
            session.add(row); session.commit()
            _grant_error("invalid_grant", "Account is unavailable")
        if not firebase_cli_session_is_active(user.firebase_uid or "", user.email, row.created_at):
            row.revoked_at, row.revoke_reason = now, "firebase_identity_changed"
            session.add(row); session.commit()
            _grant_error("invalid_grant", "Account authorization is no longer active")
        access, refresh = random_secret(32), random_secret(48)
        row.previous_refresh_token_digest = row.refresh_token_digest
        row.access_token_digest = digest(access)
        row.access_expires_at = now + timedelta(seconds=settings.access_token_seconds)
        row.refresh_token_digest = digest(refresh)
        row.last_seen_at = now
        session.add(row); session.commit()
        return _token_response(access, refresh, row, user)
    if not payload.device_code or not payload.code_verifier or not valid_code_verifier(payload.code_verifier):
        _grant_error("invalid_request", "device_code and a valid code_verifier are required")
    grant = session.exec(select(CliDeviceGrant).where(CliDeviceGrant.device_code_digest == digest(payload.device_code)).with_for_update()).first()
    if grant is None or ensure_utc(grant.expires_at) <= now:
        _grant_error("expired_token", "Device authorization expired")
    if grant.last_poll_at is not None and (now - ensure_utc(grant.last_poll_at)).total_seconds() < grant.interval_seconds:
        grant.interval_seconds = min(60, grant.interval_seconds + 5)
        grant.last_poll_at, grant.poll_count = now, grant.poll_count + 1
        session.add(grant); session.commit()
        _grant_error("slow_down", "Poll at the advertised interval.")
    grant.last_poll_at, grant.poll_count = now, grant.poll_count + 1
    if grant.poll_count > 120:
        grant.status = "expired"
        session.add(grant); session.commit()
        _grant_error("expired_token", "Device authorization polling limit reached")
    session.add(grant)
    if grant.status == "pending":
        session.commit(); _grant_error("authorization_pending", "Waiting for browser approval")
    if grant.status == "denied":
        session.commit(); _grant_error("access_denied", "The device request was denied")
    if grant.status != "approved" or grant.approved_user_id is None:
        session.commit(); _grant_error("invalid_grant", "Device authorization is not available")
    if not verify_code_challenge(payload.code_verifier, grant.code_challenge):
        grant.user_attempt_count += 1
        session.commit(); _grant_error("invalid_grant", "Proof challenge does not match")
    user = session.get(User, grant.approved_user_id)
    if user is None:
        _grant_error("invalid_grant", "Approved account is unavailable")
    grant.status, grant.consumed_at = "consumed", now
    access, refresh, row = _issue_session(session, grant, user, settings)
    session.add(grant); session.commit()
    return _token_response(access, refresh, row, user)


@router.get("/me")
def me(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    row, user = _cli_session_from_header(authorization, session)
    return {"session_id": row.id, "account": {"email": user.email, "name": user.name}, "tier": row.selected_tier, "tier_label": SWICO_TIER_LABELS.get(row.selected_tier, "Swico"), "scopes": _scope_list(row.scopes_json)}


@router.post("/logout")
def logout(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    row, _ = _cli_session_from_header(authorization, session, allow_disabled=True)
    row.revoked_at, row.revoke_reason = utc_now(), "logout"
    session.add(row)
    return {"status": "revoked"}


@router.get("/sessions")
def sessions(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    current, user = _cli_session_from_header(authorization, session, allow_disabled=True)
    rows = session.exec(select(CliSession).where(CliSession.user_id == int(user.id), CliSession.revoked_at.is_(None)).order_by(CliSession.created_at.desc())).all()
    return {"items": [{"id": row.id, "device_description": row.device_description, "created_at": row.created_at.isoformat(), "last_seen_at": row.last_seen_at.isoformat(), "current": row.id == current.id} for row in rows]}


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: str, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _current, user = _cli_session_from_header(authorization, session, allow_disabled=True)
    row = session.exec(select(CliSession).where(CliSession.id == session_id, CliSession.user_id == int(user.id)).with_for_update()).first()
    if row is None:
        raise HTTPException(404, "CLI session not found")
    row.revoked_at, row.revoke_reason = utc_now(), "website_revoked"
    session.add(row)
    return {"status": "revoked"}


@router.patch("/session/tier")
def change_tier(payload: CliTierRequest, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    row, user = _cli_session_from_header(authorization, session)
    if payload.tier == "pro" and not pro_enabled():
        raise HTTPException(422, "Swico Pro is not available yet")
    if payload.tier == "free" and not swico_free_eligible(int(user.id)):
        raise HTTPException(422, "Swico Free is not available for this account")
    row.selected_tier = normalize_swico_tier(payload.tier)
    session.add(row)
    return {"tier": row.selected_tier, "tier_label": SWICO_TIER_LABELS[row.selected_tier], "settings": public_tier_settings(row.selected_tier, free_available=swico_free_eligible(int(user.id)))}


@router.get("/usage")
def usage(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    row, user = _cli_session_from_header(authorization, session)
    return {"tier": row.selected_tier, "tier_label": SWICO_TIER_LABELS.get(row.selected_tier, "Swico"), "wallet": get_wallet_summary(session, int(user.id), swico_tier=row.selected_tier, credit_bucket="chat")}


@router.get("/threads")
def list_cli_threads(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _row, user = _cli_session_from_header(authorization, session)
    rows = session.exec(select(WebChatThread).where(WebChatThread.user_id == int(user.id), WebChatThread.archived_at.is_(None)).order_by(WebChatThread.updated_at.desc()).limit(100)).all()
    return {"items": [{"id": item.id, "title": item.title, "updated_at": item.updated_at.isoformat()} for item in rows]}


def _sse_event(name: str, payload: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n"


@router.post("/chat/stream")
async def chat_stream(payload: CliChatRequest, request: Request, authorization: str | None = Header(default=None)):
    with SessionLocal() as session:
        row, user = _cli_session_from_header(authorization, session)
        try:
            enforce_rate_limit(session, user_id=int(user.id), action="cli_chat", limit=12)
        except RateLimitError as exc:
            raise HTTPException(429, str(exc)) from exc
        session.commit()
        tier = row.selected_tier
    try:
        prepared = await asyncio.to_thread(
            prepare_web_turn, user_id=int(user.id), message=payload.message,
            request_id=str(payload.request_id), thread_id=payload.thread_id,
            reply_language=None, attachment_ids=payload.attachment_ids,
            repository_id=payload.repository_id, forced_swico_tier=tier,
            swico_free_eligible=swico_free_eligible(int(user.id)),
            input_mode="text", billing_credit_bucket="chat",
        )
    except (AttachmentRequestError, PromptBudgetExceeded) as exc:
        raise HTTPException(exc.status_code, {"code": getattr(exc, "code", "request_invalid"), "message": str(exc)}) from exc
    except DuplicateRequestInProgress as exc:
        raise HTTPException(409, {"code": "duplicate_request", "message": str(exc)}) from exc
    except SwicoTierUnavailableError as exc:
        raise HTTPException(503, {"code": "swico_tier_unavailable", "message": str(exc)}) from exc
    except Exception as exc:
        logger.exception("cli_chat_preparation_failed", extra={"request_id": str(payload.request_id)})
        raise HTTPException(503, "Swico could not prepare this request. Please try again shortly.") from exc
    if prepared.route.provider == "swico_free":
        try:
            _enforce_swico_free_limits(int(user.id))
        except SwicoFreeLimitError as exc:
            with SessionLocal() as release_session:
                release_swico_free_usage(release_session, prepared.request_id, reason=exc.code)
                release_session.commit()
            raise HTTPException(429, str(exc)) from exc
    record_web_turn_lifecycle(prepared, "reserved")

    async def events():
        from ..ai.providers.base import GenerationCancellation, GenerationCancelled
        cancellation = GenerationCancellation()
        prepared.ai_request.metadata["cancellation_signal"] = cancellation
        from ..web_api.router import register_generation, unregister_generation
        register_generation(prepared.request_id, int(user.id), cancellation)
        yield _sse_event("thread", {"thread_id": prepared.thread_id})
        yield _sse_event("status", {"phase": "routing", "tier": tier, "tier_label": SWICO_TIER_LABELS.get(tier, "Swico")})
        queue: asyncio.Queue[str] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        def delta(value: str) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, value)
        try:
            task = asyncio.create_task(asyncio.to_thread(execute_web_turn, prepared, on_delta=delta))
            while not task.done() or not queue.empty():
                try:
                    value = await asyncio.wait_for(queue.get(), timeout=0.1)
                    if value:
                        yield _sse_event("delta", {"text": value})
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        cancellation.cancel(reason="client_disconnected")
                        return
            completed = await task
            if completed.message.sources:
                yield _sse_event("sources", {"sources": list(completed.message.sources)})
            if completed.message.quality:
                yield _sse_event("quality", completed.message.quality)
            yield _sse_event("usage", {"tier": tier, "tier_label": SWICO_TIER_LABELS.get(tier, "Swico"), **completed.wallet})
            yield _sse_event("done", {
                "message_id": completed.message.id,
                "thread_id": completed.thread_id,
                "completion_status": str(completed.response.raw.get("completion_status") or "complete"),
                "input_mode": "text",
                "reply_language": prepared.reply_language,
                "sources": list(completed.message.sources),
                "quality": completed.message.quality,
                "provenance": list(completed.response.raw.get("provenance") or []),
            })
        except GenerationCancelled:
            yield _sse_event("status", {"phase": "stopped"})
            yield _sse_event("done", {"message_id": None, "thread_id": prepared.thread_id, "cancelled": True, "completion_status": "cancelled"})
        except Exception:
            logger.exception("cli_chat_execution_failed", extra={"request_id": str(payload.request_id)})
            yield _sse_event("error", {"code": "generation_failed", "message": "Swico could not complete this request. Please retry.", "retryable": True})
        finally:
            unregister_generation(prepared.request_id)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/chat/requests/{request_id}/cancel")
def cancel_chat(request_id: str, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _row, user = _cli_session_from_header(authorization, session)
    from ..web_api.router import request_generation_cancellation
    active = request_generation_cancellation(request_id, int(user.id))
    return {"status": "cancelling" if active else "cancelling", "request_id": request_id}


def _run_payload(run: CliAgentRun) -> dict[str, Any]:
    return {"run_id": run.id, "request_id": run.request_id, "status": run.status, "tier": run.tier, "max_steps": run.max_steps, "current_step": run.current_step, "expires_at": run.expires_at.isoformat()}


def _redact_planner_turn(user_id: int, request_id: str) -> None:
    """Keep planner prompts/actions out of durable chat history.

    Planning still uses the ordinary, metered Chat service, but local source
    context and structured action payloads are ephemeral client material.
    """
    from ..models import WebChatMessage
    with SessionLocal() as redact_session:
        rows = redact_session.exec(select(WebChatMessage).where(
            WebChatMessage.user_id == user_id,
            WebChatMessage.request_id == request_id,
        )).all()
        for row in rows:
            row.content = "[Swico local-agent planner turn redacted]"
            row.metadata_json = "{}"
            redact_session.add(row)
        redact_session.commit()


@router.post("/agent/runs", status_code=201)
def create_agent_run(payload: AgentRunRequest, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    settings = _require_enabled()
    if not settings.agent_enabled:
        raise HTTPException(404, {"code": "cli_agent_disabled", "message": "The local coding agent is not enabled."})
    cli_session, user = _cli_session_from_header(authorization, session, required_scope="agent")
    if cli_session.selected_tier == "free":
        raise HTTPException(403, "The local coding agent requires an eligible paid tier")
    existing = session.exec(select(CliAgentRun).where(CliAgentRun.request_id == str(payload.request_id))).first()
    if existing is not None:
        if existing.user_id != int(user.id):
            raise HTTPException(409, "Request identifier is already owned by another account")
        return _run_payload(existing)
    if payload.thread_id is not None:
        thread = session.exec(select(WebChatThread).where(
            WebChatThread.id == payload.thread_id,
            WebChatThread.user_id == int(user.id),
        )).first()
        if thread is None:
            raise HTTPException(403, "The selected conversation is not owned by this account.")
    now = utc_now()
    ceiling = agent_step_ceiling(cli_session.selected_tier)
    if ceiling <= 0:
        raise HTTPException(403, "The local coding agent requires an eligible paid tier")
    run = CliAgentRun(user_id=int(user.id), thread_id=payload.thread_id, request_id=str(payload.request_id), tier=cli_session.selected_tier, max_steps=min(settings.max_agent_steps, ceiling), task_hash=hashlib.sha256(payload.task.encode()).hexdigest(), status="running", expires_at=now + timedelta(seconds=300))
    session.add(run)
    return _run_payload(run)


@router.get("/agent/runs/{run_id}")
def get_agent_run(run_id: str, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _cli, user = _cli_session_from_header(authorization, session, required_scope="agent", allow_disabled=True)
    run = session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id, CliAgentRun.user_id == int(user.id))).first()
    if run is None:
        raise HTTPException(404, "Agent run not found")
    return _run_payload(run)


@router.post("/agent/runs/{run_id}/complete")
def complete_agent_run(run_id: str, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _cli, user = _cli_session_from_header(authorization, session, required_scope="agent", allow_disabled=True)
    run = session.exec(select(CliAgentRun).where(
        CliAgentRun.id == run_id, CliAgentRun.user_id == int(user.id)
    ).with_for_update()).first()
    if run is None:
        raise HTTPException(404, "Agent run not found")
    if run.status in {"cancelled", "failed", "expired"}:
        raise HTTPException(409, "Agent run is already terminal")
    run.status, run.terminal_reason = "completed", "client_completed"
    session.add(run)
    return _run_payload(run)


@router.post("/agent/runs/{run_id}/cancel")
def cancel_agent_run(run_id: str, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _cli, user = _cli_session_from_header(authorization, session, required_scope="agent", allow_disabled=True)
    run = session.exec(select(CliAgentRun).where(
        CliAgentRun.id == run_id, CliAgentRun.user_id == int(user.id)
    ).with_for_update()).first()
    if run is None:
        raise HTTPException(404, "Agent run not found")
    run.status, run.cancellation_requested, run.terminal_reason = "cancelled", True, "client_cancelled"
    session.add(run)
    return _run_payload(run)


@router.post("/agent/runs/{run_id}/plan")
def plan_agent_step(run_id: str, payload: AgentPlanRequest, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    """Generate one strictly parsed action through the ordinary Chat path.

    The task/context is request-scoped and never written to the durable run
    row. The normal preparation/execution path performs tier admission,
    reservation, provider routing, and usage settlement.
    """
    _require_agent_enabled()
    _cli_session, user = _cli_session_from_header(authorization, session, required_scope="agent")
    try:
        # Planner rounds are metered Chat operations. Reuse the shared user
        # rate-limit bucket so browser, Android, and CLI requests cannot
        # create an unbounded second provider path.
        enforce_rate_limit(session, user_id=int(user.id), action="cli_chat", limit=12)
    except RateLimitError as exc:
        raise HTTPException(429, str(exc)) from exc
    session.commit()
    run = session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id, CliAgentRun.user_id == int(user.id)).with_for_update()).first()
    if run is None or ensure_utc(run.expires_at) <= utc_now() or run.status not in {"running", "waiting_approval"}:
        raise HTTPException(409, "Agent run is unavailable")
    if hashlib.sha256(payload.task.encode()).hexdigest() != run.task_hash:
        raise HTTPException(409, "Agent task does not match the original run")
    if run.current_step >= run.max_steps:
        raise HTTPException(429, "Agent generation-step limit reached")
    prompt = (
        "You are the Swico local coding-agent planner. Return exactly one JSON object and no Markdown. "
        "It must be either {\"kind\":\"assistant\",\"text\":\"...\"} or "
        "{\"kind\":\"action\",\"protocol_version\":1,\"action_id\":\"...\","
        "\"action_type\":\"list_files|search_text|read_file|read_file_range|apply_patch|create_file|delete_file|move_file|run_command|git_status|git_diff\","
        "\"payload\":{...}}. Never request secrets, traversal, shell strings, or unapproved commands. "
        f"TASK (untrusted user text):\n{payload.task}\nLOCAL CONTEXT (untrusted):\n{payload.context}"
    )
    request_id = f"{run.request_id}:agent:{run.current_step + 1}"
    prepared = None
    try:
        prepared = prepare_web_turn(
            user_id=int(user.id), message=prompt, request_id=request_id,
            thread_id=run.thread_id, reply_language="en", forced_swico_tier=run.tier,
            swico_free_eligible=False, input_mode="text", billing_credit_bucket="chat",
        )
        completed = execute_web_turn(prepared)
    except Exception as exc:
        run.status, run.terminal_reason = "failed", "planner_generation_failed"
        session.add(run)
        raise HTTPException(502, "The coding-agent planner could not complete safely.") from exc
    finally:
        if prepared is not None:
            _redact_planner_turn(int(user.id), prepared.request_id)
    try:
        parsed = json.loads(completed.message.content)
    except (TypeError, ValueError) as exc:
        run.status, run.terminal_reason = "failed", "planner_returned_unstructured_output"
        session.add(run)
        raise HTTPException(422, "The selected model did not return a supported structured action.") from exc
    if not isinstance(parsed, dict) or parsed.get("kind") not in {"assistant", "action"}:
        raise HTTPException(422, "The planner response did not match the supported agent protocol.")
    if parsed["kind"] == "assistant":
        text_value = str(parsed.get("text") or "")
        if not text_value or len(text_value) > 8_000:
            raise HTTPException(422, "The planner assistant response is invalid.")
        return {"kind": "assistant", "text": text_value, "usage": completed.response.input_tokens + completed.response.output_tokens}
    # `kind` is the planner envelope discriminator, not an AgentAction field.
    # Validate the inner action after removing it so the strict extra-field
    # contract remains enabled for submitted actions.
    action_data = {key: value for key, value in parsed.items() if key != "kind"}
    try:
        action = AgentAction.model_validate(action_data)
    except Exception as exc:
        raise HTTPException(422, "The planner response did not contain a complete structured action.") from exc
    if action.payload is None:
        raise HTTPException(422, "Structured actions must include a payload.")
    payload_hash = _validate_agent_action_payload(action)
    return {"kind": "action", "protocol_version": 1, "action_id": action.action_id, "action_type": action.action_type, "payload": action.payload, "payload_hash": payload_hash, "usage": completed.response.input_tokens + completed.response.output_tokens}


@router.post("/agent/runs/{run_id}/actions")
def submit_agent_action(run_id: str, payload: AgentAction, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _require_agent_enabled()
    _cli, user = _cli_session_from_header(authorization, session, required_scope="agent")
    if not payload.payload_hash:
        raise HTTPException(422, "Action payload hash is required when submitting a local action")
    run = session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id, CliAgentRun.user_id == int(user.id)).with_for_update()).first()
    if run is None or ensure_utc(run.expires_at) <= utc_now() or run.status not in {"running", "waiting_approval"}:
        raise HTTPException(409, "Agent run is unavailable")
    if run.current_step >= run.max_steps:
        raise HTTPException(429, "Agent generation-step limit reached")
    payload_hash = _validate_agent_action_payload(payload)
    duplicate = session.exec(select(CliAgentStep).where(CliAgentStep.run_id == run.id, CliAgentStep.action_id == payload.action_id)).first()
    if duplicate is not None:
        if duplicate.payload_hash != payload_hash:
            raise HTTPException(409, "Action identity was already used for a different payload")
        return {"status": duplicate.status, "action_id": duplicate.action_id, "step_id": duplicate.id}
    step = CliAgentStep(run_id=run.id, sequence=run.current_step + 1, action_id=payload.action_id, action_type=payload.action_type, payload_hash=payload_hash, status="approved")
    pending = CliPendingAction(run_id=run.id, action_id=payload.action_id, action_type=payload.action_type, payload_hash=payload_hash, expires_at=min(ensure_utc(run.expires_at), utc_now() + timedelta(seconds=300)))
    run.current_step += 1
    run.status = "waiting_approval"
    session.add(step); session.add(pending); session.add(run)
    return {"status": "accepted", "action_id": payload.action_id, "step_id": step.id, "expires_at": pending.expires_at.isoformat()}


@router.post("/agent/runs/{run_id}/actions/{action_id}/result")
def submit_agent_result(run_id: str, action_id: str, payload: AgentResultRequest, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _cli, user = _cli_session_from_header(authorization, session, required_scope="agent", allow_disabled=True)
    if payload.action_id != action_id:
        raise HTTPException(409, "Action identity mismatch")
    run = session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id, CliAgentRun.user_id == int(user.id)).with_for_update()).first()
    step = session.exec(select(CliAgentStep).where(CliAgentStep.run_id == run_id, CliAgentStep.action_id == action_id).with_for_update()).first()
    pending = session.exec(select(CliPendingAction).where(CliPendingAction.run_id == run_id, CliPendingAction.action_id == action_id).with_for_update()).first()
    if run is None or step is None or pending is None or ensure_utc(pending.expires_at) <= utc_now() or pending.status not in {"pending", "submitted"}:
        raise HTTPException(409, "Action is expired, duplicated, or out of order")
    if pending.status == "submitted":
        if step.result_hash == payload.result_hash:
            return {"status": run.status, "run_id": run.id, "action_id": action_id, "replayed": True}
        raise HTTPException(409, "Conflicting result for an already submitted action")
    step.status, step.result_hash = payload.status, payload.result_hash
    pending.status, pending.resolved_at = "submitted", utc_now()
    run.status, run.terminal_reason = ("running", None) if payload.status == "succeeded" else ("failed", "local_action_failed_or_unknown")
    session.add(step); session.add(pending); session.add(run)
    return {"status": run.status, "run_id": run.id, "action_id": action_id}
