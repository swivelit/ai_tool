from __future__ import annotations

import json
from datetime import timezone
from typing import Any, Optional

from sqlalchemy import inspect, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlmodel import Session, select

from ..models import AIUsageEvent
from ..openai_model_router import stable_user_hash
from ..time_utils import utc_now
from .types import AIProviderResponse


def _ensure_usage_schema_compat(session: Session) -> None:
    try:
        inspector = inspect(session.get_bind())
        if not inspector.has_table("ai_usage_events"):
            return
        columns = {column["name"] for column in inspector.get_columns("ai_usage_events")}
        if "cache_hit_source" not in columns:
            session.exec(text("ALTER TABLE ai_usage_events ADD COLUMN cache_hit_source VARCHAR"))
        try:
            session.exec(text("CREATE INDEX IF NOT EXISTS ix_ai_usage_events_cache_hit_source ON ai_usage_events (cache_hit_source)"))
        except Exception:
            pass
        session.commit()
    except (OperationalError, ProgrammingError):
        session.rollback()


def _day_bounds():
    now = utc_now()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = now.replace(hour=23, minute=59, second=59, microsecond=999999)
    return start, end


def record_ai_usage_event(
    session: Optional[Session],
    response: AIProviderResponse,
    *,
    user_id: Any = None,
    request_id: Optional[str] = None,
    cache_hit: bool = False,
    latency_ms: Optional[int] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> Optional[AIUsageEvent]:
    if session is None:
        return None

    raw_metadata = dict(metadata or {})
    if response.raw:
        raw_metadata.setdefault("provider_raw", response.raw)
    raw = response.raw if isinstance(response.raw, dict) else {}
    cache_hit_source = (
        raw_metadata.get("cache_hit_source")
        or raw_metadata.get("cache_source")
        or raw.get("cache_hit_source")
        or raw.get("cache_source")
    )
    if cache_hit_source == "global_qa_cache":
        cache_hit_source = "L3_global_qa"
    if response.provider == "cache" and not cache_hit_source:
        cache_hit_source = raw.get("source") or response.route

    _ensure_usage_schema_compat(session)
    row = AIUsageEvent(
        created_at=utc_now(),
        request_id=request_id,
        user_id_hash=stable_user_hash(user_id) if user_id is not None else None,
        provider=str(response.provider or "unknown"),
        model=response.model,
        route=str(response.route or "unknown"),
        intent=str(response.intent or "general"),
        language=str(response.language or "en"),
        input_tokens=int(response.input_tokens or 0),
        output_tokens=int(response.output_tokens or 0),
        audio_seconds=float(response.audio_seconds or 0.0),
        characters=int(response.characters or len(response.text or "") or 0),
        estimated_cost_amount=float(response.estimated_cost_amount or 0.0),
        estimated_cost_currency=str(response.estimated_cost_currency or ""),
        cache_hit=bool(cache_hit or response.provider == "cache"),
        cache_hit_source=str(cache_hit_source or "") or None,
        latency_ms=int(latency_ms) if latency_ms is not None else None,
        metadata_json=json.dumps(raw_metadata, ensure_ascii=False),
    )
    try:
        session.add(row)
        session.commit()
        session.refresh(row)
    except Exception:
        session.rollback()
        raise
    return row


def get_user_daily_text_count(session: Session, user_id: Any) -> int:
    if user_id is None:
        return 0
    start, end = _day_bounds()
    user_hash = stable_user_hash(user_id)
    rows = session.exec(
        select(AIUsageEvent).where(
            AIUsageEvent.user_id_hash == user_hash,
            AIUsageEvent.created_at >= start,
            AIUsageEvent.created_at <= end,
        )
    ).all()
    return sum(
        1
        for row in rows
        if float(row.audio_seconds or 0.0) <= 0
        and str(row.route or "").lower() not in {"sarvam_stt", "sarvam_tts"}
    )


def get_user_daily_voice_seconds(session: Session, user_id: Any) -> float:
    if user_id is None:
        return 0.0
    start, end = _day_bounds()
    user_hash = stable_user_hash(user_id)
    rows = session.exec(
        select(AIUsageEvent).where(
            AIUsageEvent.user_id_hash == user_hash,
            AIUsageEvent.created_at >= start,
            AIUsageEvent.created_at <= end,
        )
    ).all()
    return float(sum(float(row.audio_seconds or 0.0) for row in rows))


def get_provider_daily_spend(session: Session, provider: str, currency: Optional[str] = None) -> float:
    start, end = _day_bounds()
    query = select(AIUsageEvent).where(
        AIUsageEvent.provider == provider,
        AIUsageEvent.created_at >= start,
        AIUsageEvent.created_at <= end,
    )
    if currency:
        query = query.where(AIUsageEvent.estimated_cost_currency == currency)
    rows = session.exec(query).all()
    return float(sum(float(row.estimated_cost_amount or 0.0) for row in rows))
