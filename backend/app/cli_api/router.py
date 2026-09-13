from __future__ import annotations

import asyncio
import base64
from datetime import timedelta
import hashlib
import json
import logging
import os
import re
from typing import Any
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
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
from ..web_api.document_extraction import (
    DocumentValidationError, image_max_file_bytes,
    image_uploads_enabled, is_image_extension,
    sanitize_filename, validate_content_signature, validate_extension_and_mime,
)
from ..web_api.router import _save_temporary_upload
from ..web_api.upload_store import EphemeralUpload, UploadStoreUnavailable, expiration_iso, get_upload_store, upload_ttl_seconds, utc_iso
from ..web_api.router import SwicoFreeLimitError, _enforce_swico_free_limits
from ..web_api.swico_free_access import swico_free_eligible
from ..web_api.usage_service import selected_swico_tier
from ..ai.swico_tiers import (
    SWICO_TIER_LABELS, SwicoTierUnavailableError,
    pro_enabled, public_tier_settings,
)
from .config import CliConfigurationError, agent_step_ceiling, cli_settings
from .contracts import (
    AgentAction, AgentResultRequest, AgentRunRequest, CliChatRequest,
    AgentPlanRequest, AgentSubagentRequest, CliTierRequest, DeviceApprovalRequest, DeviceAuthorizationRequest,
    DeviceTokenRequest, CloudJobRequest,
)
from .security import (
    digest, human_code, random_secret, valid_code_challenge,
    valid_code_verifier, verify_code_challenge,
)
from .isolated_runner import configured_isolated_runner

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/cli/v1", tags=["cli"])
CLI_PAID_TIERS = frozenset({"lite", "standard", "pro"})
CLI_PAID_TIER_ERROR = {
    "code": "cli_paid_tier_required",
    "message": "Swico CLI requires an eligible paid tier. Choose Lite, Swico, or Pro explicitly.",
}
_BLOCKED_AGENT_PATH = re.compile(
    r"(?:^|/)\.env(?:$|[./])|(?:^|/)(?:\.npmrc|\.pypirc|\.ssh|credentials?|secrets?|tokens?|node_modules|dist|build|\.git)(?:/|$)|\.(?:pem|key|p12|pfx|kdbx)$",
    re.I,
)


def _cloud_unavailable() -> None:
    """Cloud control-plane placeholder: never execute repository code in API workers."""
    runner = configured_isolated_runner()
    raise HTTPException(
        503,
        {
            "code": "cloud_execution_unavailable",
            "message": f"Cloud execution unavailable: {getattr(runner, 'reason', 'no isolated runner is configured')}.",
        },
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


@router.get("/health")
def cli_health():
    """No-cost public rollout/readiness state for CLI doctor.

    This endpoint intentionally does not require a grant, touch the database,
    or make a provider request. It replaces the old synthetic device lookup,
    whose 404 could not distinguish a healthy disabled rollout from a broken
    route.
    """
    settings = _settings()
    return {
        "status": "ok",
        "cli_enabled": settings.enabled,
        "agent_enabled": settings.agent_enabled if settings.enabled else False,
        "cloud_agent_enabled": settings.cloud_agent_enabled if settings.enabled else False,
        "message": "Swico CLI is enabled." if settings.enabled else "Swico CLI is disabled.",
    }


@router.post("/cloud/jobs")
def create_cloud_job(payload: CloudJobRequest, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    """Reserve no work and fail closed until a separately isolated runner exists."""
    _cli_session_from_header(authorization, session, required_scope="agent")
    _cloud_unavailable()


@router.get("/cloud/jobs/{job_id}")
def get_cloud_job(job_id: str, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    if not job_id or len(job_id) > 128:
        raise HTTPException(404, "Cloud job not found")
    _cli_session_from_header(authorization, session, required_scope="agent", allow_disabled=True)
    _cloud_unavailable()


@router.post("/cloud/jobs/{job_id}/cancel")
def cancel_cloud_job(job_id: str, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    if not job_id or len(job_id) > 128:
        raise HTTPException(404, "Cloud job not found")
    _cli_session_from_header(authorization, session, required_scope="agent", allow_disabled=True)
    _cloud_unavailable()


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
    allowed_fields = {
        "list_files": {"limit"},
        "search_text": {"term", "limit", "regex", "glob", "context_lines"},
        "read_file": {"path"},
        "read_file_range": {"path", "start", "end"},
        "apply_patch": {"path", "expected_sha256", "patch", "content"},
        "create_file": {"path", "content"},
        "delete_file": {"path"},
        "move_file": {"from", "to"},
        "run_command": {"argv", "timeout_ms", "network"},
        "git_status": set(),
        "git_diff": {"ref"},
        "mcp_tool": {"server_name", "tool_name", "arguments"},
        "spawn_subagent": {"tasks", "context"},
        "web_search": {"query"},
    }[action.action_type]
    unknown_fields = set(payload) - allowed_fields
    if unknown_fields:
        raise HTTPException(422, f"{action.action_type} payload contains unsupported fields.")
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
        network = payload.get("network", "disabled")
        if (
            not isinstance(argv, list) or not argv or len(argv) > 32
            or any(not isinstance(value, str) or not value or len(value) > 512 for value in argv)
            or not isinstance(timeout, int) or isinstance(timeout, bool)
            or not 100 <= timeout <= 120_000
            or network not in {"disabled", "allowed"}
        ):
            raise HTTPException(422, "run_command payload is invalid or outside the supported bound.")
    elif action.action_type == "git_diff":
        ref = payload.get("ref")
        if ref is not None and (not isinstance(ref, str) or len(ref) > 256 or any(char in ref for char in "\x00\r\n")):
            raise HTTPException(422, "git_diff ref is invalid.")
    elif action.action_type == "mcp_tool":
        if action.protocol_version != 2:
            raise HTTPException(422, "MCP actions require protocol version 2.")
        server_name, tool_name, arguments = payload.get("server_name"), payload.get("tool_name"), payload.get("arguments", {})
        if (not isinstance(server_name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", server_name)
                or not isinstance(tool_name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", tool_name)
                or not isinstance(arguments, dict) or len(json.dumps(arguments, separators=(",", ":"))) > 32 * 1024):
            raise HTTPException(422, "MCP action payload is invalid or too large.")
    elif action.action_type == "spawn_subagent":
        if action.protocol_version != 2:
            raise HTTPException(422, "Subagent actions require protocol version 2.")
        tasks = payload.get("tasks")
        if (not isinstance(tasks, list) or not 1 <= len(tasks) <= 4
                or any(not isinstance(item, dict) or not isinstance(item.get("id"), str)
                       or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", item["id"])
                       or not isinstance(item.get("task"), str) or not item["task"] or len(item["task"]) > 2_000
                       for item in tasks)):
            raise HTTPException(422, "Subagent tasks must be a bounded list of read-only tasks.")
        context = payload.get("context", "")
        if not isinstance(context, str) or len(context) > 8_000:
            raise HTTPException(422, "Subagent context is outside the supported bound.")
    elif action.action_type == "web_search":
        if action.protocol_version != 2:
            raise HTTPException(422, "Web search actions require protocol version 2.")
        query = payload.get("query")
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 2_000:
            raise HTTPException(422, "Web search query is outside the supported bound.")
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


def _require_cli_paid_tier(value: object, *, unavailable_status: int = 403) -> str:
    tier = str(value or "").strip().lower()
    if tier not in CLI_PAID_TIERS:
        raise HTTPException(unavailable_status, CLI_PAID_TIER_ERROR)
    if tier == "pro" and not pro_enabled():
        raise HTTPException(422, {"code": "cli_tier_unavailable", "message": "Swico Pro is not currently available."})
    return tier


def _require_paid_cli_session(row: CliSession) -> None:
    _require_cli_paid_tier(row.selected_tier)


def _issue_session(session: Session, grant: CliDeviceGrant, user: User, settings) -> tuple[str, str, CliSession]:
    now = utc_now()
    access, refresh = random_secret(32), random_secret(48)
    selected = _require_cli_paid_tier(grant.requested_tier or selected_swico_tier(session, int(user.id)))
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
    if payload.tier is not None:
        _require_cli_paid_tier(payload.tier, unavailable_status=422)
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
        requested_tier=payload.tier,
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
    return {"user_code": user_code.strip().upper(), "device_description": grant.device_description, "scopes": _scope_list(grant.scopes_json), "tier": grant.requested_tier, "status": grant.status, "expires_at": grant.expires_at.isoformat()}


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
    _require_paid_cli_session(row)
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
    row.selected_tier = _require_cli_paid_tier(payload.tier, unavailable_status=422)
    session.add(row)
    return {"tier": row.selected_tier, "tier_label": SWICO_TIER_LABELS[row.selected_tier], "settings": public_tier_settings(row.selected_tier, free_available=swico_free_eligible(int(user.id)))}


@router.get("/usage")
def usage(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    row, user = _cli_session_from_header(authorization, session)
    _require_paid_cli_session(row)
    return {"tier": row.selected_tier, "tier_label": SWICO_TIER_LABELS.get(row.selected_tier, "Swico"), "wallet": get_wallet_summary(session, int(user.id), swico_tier=row.selected_tier, credit_bucket="chat")}


@router.get("/threads")
def list_cli_threads(authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _row, user = _cli_session_from_header(authorization, session)
    _require_paid_cli_session(_row)
    rows = session.exec(select(WebChatThread).where(WebChatThread.user_id == int(user.id), WebChatThread.archived_at.is_(None)).order_by(WebChatThread.updated_at.desc()).limit(100)).all()
    return {"items": [{"id": item.id, "title": item.title, "updated_at": item.updated_at.isoformat()} for item in rows]}


@router.post("/uploads", status_code=201)
async def upload_cli_attachment(file: UploadFile = File(...), authorization: str | None = Header(default=None)):
    """CLI-authenticated temporary upload, reusing the website's bounded store.

    The CLI bearer session is resolved before any bytes are retained. Free
    sessions remain text-only and the upload keeps the ordinary 300-second
    ownership/expiry semantics.
    """
    with SessionLocal() as session:
        row, user = _cli_session_from_header(authorization, session)
        _require_paid_cli_session(row)
    safe_name = sanitize_filename(file.filename or "attachment")
    try:
        extension, media_type = validate_extension_and_mime(safe_name, file.content_type)
        if not is_image_extension(extension):
            raise DocumentValidationError(415, "cli_image_required", "CLI image input currently accepts image files only.")
        if not image_uploads_enabled():
            raise DocumentValidationError(503, "image_uploads_disabled", "Image attachments are not enabled.")
        temp_path, size = await _save_temporary_upload(file, limit=image_max_file_bytes(), suffix=extension)
        try:
            validate_content_signature(temp_path, extension)
            binary_base64 = base64.b64encode(Path(temp_path).read_bytes()).decode("ascii")
        finally:
            os.remove(temp_path)
        upload = EphemeralUpload(
            id=str(uuid4()), owner_user_id=int(user.id), name=safe_name,
            extension=extension, media_type=media_type, size_bytes=size, created_at=utc_iso(),
            expires_at=expiration_iso(upload_ttl_seconds()), chunks=[], source_locators=[], warnings=[],
            binary_base64=binary_base64,
        )
        get_upload_store().put(upload)
        return JSONResponse(status_code=201, content=upload.display_metadata(), headers={"Cache-Control": "no-store"})
    except DocumentValidationError as exc:
        await file.close()
        raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.message}) from exc
    except UploadStoreUnavailable as exc:
        raise HTTPException(503, {"code": "attachment_cache_unavailable", "message": "Temporary attachments are unavailable."}) from exc


@router.delete("/uploads/{upload_id}", status_code=204)
def delete_cli_attachment(upload_id: str, authorization: str | None = Header(default=None)):
    with SessionLocal() as session:
        _row, user = _cli_session_from_header(authorization, session)
    upload = get_upload_store().get(upload_id)
    if upload is not None and upload.owner_user_id != int(user.id):
        raise HTTPException(404, "Attachment not found.")
    if upload is not None:
        get_upload_store().delete(upload_id)
    return None


def _sse_event(name: str, payload: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\n\n"


@router.post("/chat/stream")
async def chat_stream(payload: CliChatRequest, request: Request, authorization: str | None = Header(default=None)):
    with SessionLocal() as session:
        row, user = _cli_session_from_header(authorization, session)
        _require_paid_cli_session(row)
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
            search_mode=payload.search_mode, output_schema=payload.output_schema,
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


def _fail_agent_run(run_id: str, reason: str) -> None:
    """Record a planner failure without retaining a request-time row lock."""
    with SessionLocal() as failure_session:
        run = failure_session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id).with_for_update()).first()
        if run is not None and run.status in {"running", "waiting_approval"}:
            run.status, run.terminal_reason = "failed", reason
            failure_session.add(run)
            failure_session.commit()


def _active_agent_run(run_id: str, user_id: int) -> CliAgentRun | None:
    with SessionLocal() as check_session:
        run = check_session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id, CliAgentRun.user_id == user_id)).first()
        if run is None or ensure_utc(run.expires_at) <= utc_now() or run.status not in {"running", "waiting_approval"} or run.cancellation_requested:
            return None
        return run


def _settle_planner_reservation(
    run_id: str,
    reservation_id: str,
    *,
    status: str,
    action_type: str,
    payload_hash: str,
    action_id: str | None = None,
    result_hash: str | None = None,
) -> bool:
    """Finalize a generation reservation after provider I/O.

    The provider is never called while these row locks are held. The second
    transaction rechecks cancellation/terminal state so a late provider result
    cannot authorize an action after cancellation.
    """
    with SessionLocal() as settle_session:
        run = settle_session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id).with_for_update()).first()
        step = settle_session.exec(select(CliAgentStep).where(
            CliAgentStep.run_id == run_id, CliAgentStep.reservation_id == reservation_id,
        ).with_for_update()).first()
        if run is None or step is None or step.status != "pending":
            return False
        if run.cancellation_requested or run.status not in {"running", "waiting_approval"} or ensure_utc(run.expires_at) <= utc_now():
            step.status = "expired"
            step.updated_at = utc_now()
            settle_session.add(step)
            settle_session.commit()
            return False
        step.status = status
        step.action_type = action_type
        step.payload_hash = payload_hash
        if action_id is not None:
            duplicate = settle_session.exec(select(CliAgentStep).where(
                CliAgentStep.run_id == run_id, CliAgentStep.action_id == action_id,
            )).first()
            if duplicate is not None and duplicate.id != step.id:
                step.status = "failed"
                settle_session.add(step)
                settle_session.commit()
                return False
            step.action_id = action_id
        step.result_hash = result_hash
        step.updated_at = utc_now()
        if action_id is not None:
            pending = CliPendingAction(
                run_id=run_id, action_id=action_id, action_type=action_type,
                payload_hash=payload_hash, status="pending",
                expires_at=min(ensure_utc(run.expires_at), utc_now() + timedelta(seconds=300)),
            )
            settle_session.add(pending)
            run.status = "waiting_approval"
            run.updated_at = utc_now()
            settle_session.add(run)
        settle_session.add(step)
        settle_session.commit()
        return True


def _fail_planner_reservation(run_id: str, reservation_id: str) -> None:
    with SessionLocal() as failure_session:
        step = failure_session.exec(select(CliAgentStep).where(
            CliAgentStep.run_id == run_id, CliAgentStep.reservation_id == reservation_id,
        ).with_for_update()).first()
        if step is not None and step.status == "pending":
            step.status = "failed"
            step.updated_at = utc_now()
            failure_session.add(step)
            failure_session.commit()


def _planner_payload_contract() -> str:
    return (
        "Exact action payload schemas (additional fields are invalid): "
        "list_files {limit?: integer 1..500}; "
        "search_text {term: string, limit?: integer, regex?: boolean, glob?: string, context_lines?: integer}; "
        "read_file {path: safe relative string}; "
        "read_file_range {path: safe relative string, start?: integer, end?: integer}; "
        "apply_patch {path: safe relative string, expected_sha256: 64-hex string, patch|string or content|string}; "
        "create_file {path: safe relative string, content: string}; "
        "delete_file {path: safe relative string}; "
        "move_file {from: safe relative string, to: safe relative string}; "
        "run_command {argv: non-empty string array, timeout_ms?: integer 100..120000, network?: disabled|allowed}; "
        "git_status {}; git_diff {ref?: string}; "
        "mcp_tool {server_name: identifier, tool_name: identifier, arguments?: object}; "
        "spawn_subagent {tasks: 1..4 bounded read-only task objects, context?: string}; "
        "web_search {query: string}."
    )


@router.post("/agent/runs", status_code=201)
def create_agent_run(payload: AgentRunRequest, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    settings = _require_enabled()
    if not settings.agent_enabled:
        raise HTTPException(404, {"code": "cli_agent_disabled", "message": "The local coding agent is not enabled."})
    cli_session, user = _cli_session_from_header(authorization, session, required_scope="agent")
    _require_paid_cli_session(cli_session)
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
    run = CliAgentRun(user_id=int(user.id), thread_id=payload.thread_id, request_id=str(payload.request_id), tier=cli_session.selected_tier, max_steps=min(settings.max_agent_steps, ceiling), task_hash=hashlib.sha256(payload.task.encode()).hexdigest(), status="running", expires_at=now + timedelta(seconds=settings.agent_run_seconds))
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
    _require_paid_cli_session(_cli_session)
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
    outstanding = session.exec(select(CliAgentStep).where(
        CliAgentStep.run_id == run.id,
        CliAgentStep.status == "pending",
        CliAgentStep.action_type == "planner_reservation",
    )).first()
    if outstanding is not None:
        raise HTTPException(409, "A planner generation is already in progress; retrying will not generate another round.")
    awaiting_action = session.exec(select(CliPendingAction).where(
        CliPendingAction.run_id == run.id,
        CliPendingAction.status == "pending",
    )).first()
    if awaiting_action is not None:
        raise HTTPException(409, "The previous planned action is awaiting local execution; retrying will not generate another round.")
    if run.current_step >= run.max_steps:
        raise HTTPException(429, "Agent generation-step limit reached")
    # Reserve the planner round atomically, then release the database lock
    # before any model I/O. A competing cancel/complete can therefore win
    # while the provider is running and is rechecked before the result is
    # accepted.
    run_id_value = run.id
    run_request_id = run.request_id
    run_thread_id = run.thread_id
    run_tier = run.tier
    step_number = run.current_step + 1
    reservation_id = str(uuid4())
    run.current_step = step_number
    session.add(CliAgentStep(
        run_id=run.id, sequence=step_number, action_id=reservation_id,
        reservation_id=reservation_id, action_type="planner_reservation",
        payload_hash=run.task_hash, status="pending",
    ))
    session.add(run)
    session.commit()
    prompt = (
        "You are the Swico local coding-agent planner. Return exactly one JSON object and no Markdown. "
        "It must be either {\"kind\":\"assistant\",\"text\":\"...\"} or "
        "{\"kind\":\"action\",\"protocol_version\":1 or 2,\"action_id\":\"...\","
        "\"action_type\":\"list_files|search_text|read_file|read_file_range|apply_patch|create_file|delete_file|move_file|run_command|git_status|git_diff|mcp_tool|spawn_subagent|web_search\","
        "\"payload\":{...}}. Never request secrets, traversal, shell strings, or unapproved commands. "
        f"{_planner_payload_contract()} "
        f"TASK (untrusted user text):\n{payload.task}\nLOCAL CONTEXT (untrusted):\n{payload.context}"
    )
    request_id = f"{run_request_id}:agent:{step_number}"
    prepared = None
    try:
        prepared = prepare_web_turn(
            user_id=int(user.id), message=prompt, request_id=request_id,
            thread_id=run_thread_id, reply_language="en", forced_swico_tier=run_tier,
            swico_free_eligible=False, input_mode="text", billing_credit_bucket="chat",
        )
        completed = execute_web_turn(prepared)
    except Exception as exc:
        _fail_planner_reservation(run_id_value, reservation_id)
        _fail_agent_run(run_id_value, "planner_generation_failed")
        raise HTTPException(502, "The coding-agent planner could not complete safely.") from exc
    finally:
        if prepared is not None:
            _redact_planner_turn(int(user.id), prepared.request_id)
    try:
        parsed = json.loads(completed.message.content)
    except (TypeError, ValueError) as exc:
        _fail_planner_reservation(run_id_value, reservation_id)
        _fail_agent_run(run_id_value, "planner_returned_unstructured_output")
        raise HTTPException(422, "The selected model did not return a supported structured action.") from exc
    if _active_agent_run(run_id_value, int(user.id)) is None:
        _fail_planner_reservation(run_id_value, reservation_id)
        raise HTTPException(409, "The agent run was cancelled or became terminal while planning.")
    if not isinstance(parsed, dict) or parsed.get("kind") not in {"assistant", "action"}:
        _fail_planner_reservation(run_id_value, reservation_id)
        raise HTTPException(422, "The planner response did not match the supported agent protocol.")
    if parsed["kind"] == "assistant":
        text_value = str(parsed.get("text") or "")
        if not text_value or len(text_value) > 8_000:
            _fail_planner_reservation(run_id_value, reservation_id)
            raise HTTPException(422, "The planner assistant response is invalid.")
        if not _settle_planner_reservation(
            run_id_value, reservation_id, status="succeeded", action_type="assistant_response",
            payload_hash=hashlib.sha256(text_value.encode()).hexdigest(),
            result_hash=hashlib.sha256(text_value.encode()).hexdigest(),
        ):
            raise HTTPException(409, "The agent run was cancelled or became terminal while planning.")
        return {"kind": "assistant", "text": text_value, "usage": completed.response.input_tokens + completed.response.output_tokens}
    # `kind` is the planner envelope discriminator, not an AgentAction field.
    # Validate the inner action after removing it so the strict extra-field
    # contract remains enabled for submitted actions.
    action_data = {key: value for key, value in parsed.items() if key != "kind"}
    try:
        action = AgentAction.model_validate(action_data)
    except Exception as exc:
        _fail_planner_reservation(run_id_value, reservation_id)
        raise HTTPException(422, "The planner response did not contain a complete structured action.") from exc
    if action.payload is None:
        _fail_planner_reservation(run_id_value, reservation_id)
        raise HTTPException(422, "Structured actions must include a payload.")
    try:
        payload_hash = _validate_agent_action_payload(action)
    except HTTPException:
        _fail_planner_reservation(run_id_value, reservation_id)
        raise
    if not _settle_planner_reservation(
        run_id_value, reservation_id, status="approved", action_type=action.action_type,
        payload_hash=payload_hash, action_id=action.action_id,
    ):
        raise HTTPException(409, "The planned action reservation is no longer active.")
    return {"kind": "action", "protocol_version": action.protocol_version, "action_id": action.action_id, "action_type": action.action_type, "payload": action.payload, "payload_hash": payload_hash, "reservation_id": reservation_id, "usage": completed.response.input_tokens + completed.response.output_tokens}


@router.post("/agent/runs/{run_id}/subagents")
def run_read_only_subagents(run_id: str, payload: AgentSubagentRequest, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    """Run bounded read-only analysis through the metered Chat service.

    The CLI supplies only bounded local observations. This endpoint deliberately
    has no local filesystem or command access: each subagent is a separate
    server-authorized Chat generation and its transient prompt/message is
    redacted after completion. The durable run records only the step count.
    """
    _require_agent_enabled()
    _cli_session, user = _cli_session_from_header(authorization, session, required_scope="agent")
    _require_paid_cli_session(_cli_session)
    run = session.exec(select(CliAgentRun).where(
        CliAgentRun.id == run_id, CliAgentRun.user_id == int(user.id)
    ).with_for_update()).first()
    if run is None or ensure_utc(run.expires_at) <= utc_now() or run.status not in {"running", "waiting_approval"}:
        raise HTTPException(409, "Agent run is unavailable")
    if run.cancellation_requested:
        raise HTTPException(409, "Agent run was cancelled")
    pending = session.exec(select(CliPendingAction).where(
        CliPendingAction.run_id == run_id,
        CliPendingAction.action_id == payload.action_id,
        CliPendingAction.action_type == "spawn_subagent",
    ).with_for_update()).first()
    if pending is None:
        raise HTTPException(409, "The subagent action is missing, expired, or already submitted")
    if pending.status == "submitted":
        # The summaries are intentionally not retained in durable recovery
        # state. A lost response is therefore an idempotent no-op, never a
        # second set of provider calls or step reservations.
        return {"run_id": run.id, "results": [], "active": 0, "max_active": 4, "replayed": True}
    if pending.status != "pending":
        raise HTTPException(409, "The subagent action is missing, expired, or already submitted")
    # The spawn action itself consumes one step. Every independent model
    # analysis round consumes another, so this cannot bypass the run ceiling.
    if run.current_step + len(payload.tasks) > run.max_steps:
        raise HTTPException(429, "Agent subagent generation-step limit reached")
    try:
        enforce_rate_limit(session, user_id=int(user.id), action="cli_chat", limit=12)
    except RateLimitError as exc:
        raise HTTPException(429, str(exc)) from exc
    run.current_step += len(payload.tasks)
    session.add(run)
    session.commit()
    run_id_value = run.id
    run_thread_id = run.thread_id
    run_tier = run.tier
    run_request_id = run.request_id
    summaries: list[dict[str, object]] = []
    for item in payload.tasks:
        if _active_agent_run(run_id_value, int(user.id)) is None:
            raise HTTPException(409, "Agent subagent run was cancelled or expired")
        prompt = (
            "You are a bounded Swico read-only repository analysis subagent. "
            "Return a concise factual summary (at most 2,000 characters), no actions, "
            "commands, secrets, or claims that are not supported by the supplied observations. "
            f"SUBTASK (untrusted):\n{item.task}\nOBSERVATIONS (untrusted):\n{payload.context}"
        )
        prepared = None
        # Stable and short per-task request IDs make a reconnect an ordinary
        # shared-Chat idempotent replay rather than another paid generation.
        task_key = hashlib.sha256(f"{payload.action_id}:{item.id}".encode()).hexdigest()[:16]
        request_id = f"{run_request_id}:subagent:{task_key}"
        try:
            prepared = prepare_web_turn(
                user_id=int(user.id), message=prompt, request_id=request_id,
                thread_id=run_thread_id, reply_language="en", forced_swico_tier=run_tier,
                swico_free_eligible=False, input_mode="text", billing_credit_bucket="chat",
            )
            completed = execute_web_turn(prepared)
            summaries.append({"id": item.id, "summary": completed.message.content[:2_000], "usage": completed.response.input_tokens + completed.response.output_tokens})
        except Exception as exc:
            raise HTTPException(502, "A read-only subagent could not complete safely.") from exc
        finally:
            if prepared is not None:
                _redact_planner_turn(int(user.id), prepared.request_id)
    if _active_agent_run(run_id_value, int(user.id)) is None:
        raise HTTPException(409, "Agent subagent run was cancelled or expired")
    with SessionLocal() as finalize_session:
        final_pending = finalize_session.exec(select(CliPendingAction).where(
            CliPendingAction.run_id == run_id, CliPendingAction.action_id == payload.action_id,
        ).with_for_update()).first()
        final_step = finalize_session.exec(select(CliAgentStep).where(
            CliAgentStep.run_id == run_id, CliAgentStep.action_id == payload.action_id,
        ).with_for_update()).first()
        if final_pending is not None and final_step is not None and final_pending.status == "pending":
            final_pending.status, final_pending.resolved_at = "submitted", utc_now()
            final_step.status, final_step.result_hash, final_step.updated_at = "succeeded", hashlib.sha256(json.dumps(summaries, sort_keys=True).encode()).hexdigest(), utc_now()
            finalize_session.add(final_pending); finalize_session.add(final_step); finalize_session.commit()
    return {"run_id": run.id, "results": summaries, "active": 0, "max_active": 4}


@router.post("/agent/runs/{run_id}/actions")
def submit_agent_action(run_id: str, payload: AgentAction, authorization: str | None = Header(default=None), session: Session = Depends(get_session)):
    _require_agent_enabled()
    _cli, user = _cli_session_from_header(authorization, session, required_scope="agent")
    _require_paid_cli_session(_cli)
    if not payload.payload_hash:
        raise HTTPException(422, "Action payload hash is required when submitting a local action")
    payload_hash = _validate_agent_action_payload(payload)
    run = session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id, CliAgentRun.user_id == int(user.id)).with_for_update()).first()
    if run is None:
        raise HTTPException(409, "Agent run is unavailable")
    duplicate = session.exec(select(CliAgentStep).where(CliAgentStep.run_id == run.id, CliAgentStep.action_id == payload.action_id)).first()
    if duplicate is not None:
        if duplicate.payload_hash != payload_hash:
            raise HTTPException(409, "Action identity was already used for a different payload")
        # A lost admission response is safe to replay. The local journal will
        # decide whether the side effect already ran; an admitted-but-not-
        # settled action must remain executable after reconnect.
        replay_status = "accepted" if duplicate.status in {"pending", "approved", "executing"} else duplicate.status
        return {"status": replay_status, "action_id": duplicate.action_id, "step_id": duplicate.id}
    if ensure_utc(run.expires_at) <= utc_now() or run.status not in {"running", "waiting_approval"} or run.cancellation_requested:
        raise HTTPException(409, "Agent run is unavailable")
    if payload.reservation_id is not None:
        reservation = session.exec(select(CliAgentStep).where(
            CliAgentStep.run_id == run.id, CliAgentStep.reservation_id == payload.reservation_id,
        ).with_for_update()).first()
        if (
            reservation is None
            or reservation.action_id != payload.action_id
            or reservation.action_type != payload.action_type
            or reservation.payload_hash != payload_hash
            or reservation.status != "approved"
        ):
            raise HTTPException(409, "The action does not match its planner reservation")
        pending = session.exec(select(CliPendingAction).where(
            CliPendingAction.run_id == run.id, CliPendingAction.action_id == payload.action_id,
        )).first()
        if pending is None or ensure_utc(pending.expires_at) <= utc_now() or pending.status != "pending":
            raise HTTPException(409, "The planned action authorization is missing or expired")
        return {"status": "accepted", "action_id": payload.action_id, "step_id": reservation.id, "expires_at": pending.expires_at.isoformat()}
    if run.current_step >= run.max_steps:
        raise HTTPException(429, "Agent generation-step limit reached")
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
    if run is None or step is None or pending is None:
        raise HTTPException(409, "Action is expired, duplicated, or out of order")
    if ensure_utc(pending.expires_at) <= utc_now():
        pending.status, pending.resolved_at = "expired", utc_now()
        step.status, step.updated_at = "expired", utc_now()
        session.add(pending); session.add(step); session.commit()
        raise HTTPException(409, "Action authorization expired")
    if pending.status not in {"pending", "submitted"}:
        raise HTTPException(409, "Action is expired, duplicated, or out of order")
    if pending.status == "submitted":
        if step.result_hash == payload.result_hash:
            return {"status": run.status, "run_id": run.id, "action_id": action_id, "replayed": True}
        raise HTTPException(409, "Conflicting result for an already submitted action")
    if run.status in {"cancelled", "completed", "failed", "expired"} or run.cancellation_requested:
        # A result may arrive after cancellation or terminal completion. It is
        # evidence of what happened locally, but must not reopen the run or
        # grant another model/action opportunity.
        raise HTTPException(409, "The agent run is terminal; this action result cannot be accepted")
    step.status, step.result_hash = payload.status, payload.result_hash
    pending.status, pending.resolved_at = "submitted", utc_now()
    run.status, run.terminal_reason = ("running", None) if payload.status == "succeeded" else ("failed", "local_action_failed_or_unknown")
    session.add(step); session.add(pending); session.add(run)
    return {"status": run.status, "run_id": run.id, "action_id": action_id}
