from __future__ import annotations

from datetime import datetime, timezone
import threading
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import event, func
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from ..database import IS_POSTGRES
from ..models import UsageCharge, User, WebUsagePeriodLock, WebUsagePreferences
from ..time_utils import ensure_utc, utc_now
from .errors import UsageLimitReachedError


_sqlite_locks_guard = threading.Lock()
_sqlite_user_locks: dict[int, threading.RLock] = {}


def acquire_sqlite_usage_transaction_lock(session: Session, user_id: int) -> None:
    """Mirror PostgreSQL row-lock serialization in SQLite test/development.

    SQLite ignores SELECT FOR UPDATE. Holding a process lock until the outer
    transaction ends makes concurrency tests meaningful without changing the
    PostgreSQL production path.
    """
    if IS_POSTGRES or session.info.get("usage_transaction_lock") is not None:
        return
    with _sqlite_locks_guard:
        lock = _sqlite_user_locks.setdefault(int(user_id), threading.RLock())
    lock.acquire()
    session.info["usage_transaction_lock"] = lock

    def release(_session, transaction) -> None:
        if transaction.parent is not None:
            return
        held = _session.info.pop("usage_transaction_lock", None)
        if held is not None:
            held.release()

    event.listen(session, "after_transaction_end", release)


def validated_timezone(value: str) -> ZoneInfo:
    name = str(value or "").strip()
    if not name or len(name) > 64:
        raise ValueError("Select a valid IANA timezone.")
    try:
        zone = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("Select a valid IANA timezone.") from None
    if zone.key != name:
        raise ValueError("Select a valid IANA timezone.")
    return zone


def monthly_period_bounds(
    timezone_name: str, now: datetime | None = None,
) -> tuple[datetime, datetime]:
    zone = validated_timezone(timezone_name)
    current = ensure_utc(now or utc_now()).astimezone(zone)
    local_start = current.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if local_start.month == 12:
        local_end = local_start.replace(year=local_start.year + 1, month=1)
    else:
        local_end = local_start.replace(month=local_start.month + 1)
    return local_start.astimezone(timezone.utc), local_end.astimezone(timezone.utc)


def _locked_period_row(
    session: Session, *, user_id: int, period_start: datetime,
) -> WebUsagePeriodLock:
    start = ensure_utc(period_start)
    if IS_POSTGRES:
        now = utc_now()
        session.exec(
            postgresql_insert(WebUsagePeriodLock).values(
                id=str(uuid4()),
                user_id=int(user_id),
                period_start_utc=start,
                created_at=now,
                updated_at=now,
            ).on_conflict_do_nothing(
                constraint="uq_web_usage_period_lock_user_start"
            )
        )
        return session.exec(
            select(WebUsagePeriodLock).where(
                WebUsagePeriodLock.user_id == int(user_id),
                WebUsagePeriodLock.period_start_utc == start,
            ).with_for_update()
        ).one()
    row = session.exec(
        select(WebUsagePeriodLock).where(
            WebUsagePeriodLock.user_id == int(user_id),
            WebUsagePeriodLock.period_start_utc == start,
        ).with_for_update()
    ).first()
    if row is None:
        row = WebUsagePeriodLock(user_id=int(user_id), period_start_utc=start)
        try:
            with session.begin_nested():
                session.add(row)
                session.flush()
        except IntegrityError:
            row = session.exec(
                select(WebUsagePeriodLock).where(
                    WebUsagePeriodLock.user_id == int(user_id),
                    WebUsagePeriodLock.period_start_utc == start,
                ).with_for_update()
            ).one()
    return row


def _usage_totals(
    session: Session, *, user_id: int, period_start: datetime, period_end: datetime,
    exclude_request_id: str | None = None,
) -> tuple[int, int]:
    settled = session.exec(
        select(func.coalesce(func.sum(UsageCharge.debited_micros), 0)).where(
            UsageCharge.user_id == int(user_id),
            UsageCharge.status == "settled",
            UsageCharge.settled_at >= period_start,
            UsageCharge.settled_at < period_end,
        )
    ).one()
    active_statement = select(
        func.coalesce(func.sum(UsageCharge.reserved_micros), 0)
    ).where(
        UsageCharge.user_id == int(user_id), UsageCharge.status == "reserved"
    )
    if exclude_request_id:
        active_statement = active_statement.where(
            UsageCharge.request_id != exclude_request_id
        )
    active = session.exec(active_statement).one()
    return int(settled or 0), int(active or 0)


def usage_limit_state(
    session: Session, *, user_id: int, required_micros: int = 0,
    now: datetime | None = None, lock: bool = False,
    exclude_request_id: str | None = None,
) -> dict[str, int | datetime | None]:
    user = session.get(User, int(user_id))
    if user is None:
        raise LookupError("User not found")
    start, end = monthly_period_bounds(user.timezone, now)
    preferences = session.exec(
        select(WebUsagePreferences).where(WebUsagePreferences.user_id == int(user_id))
    ).first()
    limit = int(preferences.hard_limit_micros) if preferences and preferences.hard_limit_micros is not None else None
    if lock and limit is not None:
        _locked_period_row(session, user_id=int(user_id), period_start=start)
    settled, active = _usage_totals(
        session, user_id=int(user_id), period_start=start, period_end=end,
        exclude_request_id=exclude_request_id,
    )
    current = settled + active
    remaining = None if limit is None else max(0, limit - current)
    return {
        "limit_micros": limit,
        "settled_micros": settled,
        "active_reserved_micros": active,
        "current_usage_micros": current,
        "remaining_micros": remaining,
        "period_start": start,
        "period_end": end,
        "required_micros": max(0, int(required_micros)),
    }


def enforce_usage_limit(
    session: Session, *, user_id: int, required_micros: int,
    now: datetime | None = None,
) -> dict[str, int | datetime | None]:
    state = usage_limit_state(
        session, user_id=user_id, required_micros=required_micros,
        now=now, lock=True,
    )
    limit = state["limit_micros"]
    required = max(0, int(required_micros))
    if limit is not None and int(state["current_usage_micros"] or 0) + required > int(limit):
        raise UsageLimitReachedError(
            current_usage_micros=int(state["current_usage_micros"] or 0),
            configured_limit_micros=int(limit),
            remaining_micros=int(state["remaining_micros"] or 0),
            reset_at=ensure_utc(state["period_end"]).isoformat(),
        )
    return state


def settlement_limit_available(
    session: Session, *, user_id: int, request_id: str,
    now: datetime | None = None,
) -> int | None:
    state = usage_limit_state(
        session, user_id=user_id, now=now, lock=True,
        exclude_request_id=request_id,
    )
    limit = state["limit_micros"]
    if limit is None:
        return None
    return max(0, int(limit) - int(state["current_usage_micros"] or 0))
