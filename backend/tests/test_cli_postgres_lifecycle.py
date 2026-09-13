from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import time
from uuid import uuid4

import pytest
from sqlmodel import select

from app.database import SessionLocal, engine
from app.models import CliAgentRun
from app.time_utils import utc_now
from tests.conftest import create_test_user


pytestmark = pytest.mark.skipif(
    engine.dialect.name != "postgresql",
    reason="requires TEST_DATABASE_URL pointing at a disposable PostgreSQL database",
)


def test_postgres_agent_step_reservation_serializes_concurrent_workers():
    """The run row lock serializes reservations without spanning model I/O."""
    user = create_test_user(f"cli-pg-{uuid4()}", f"cli-pg-{uuid4()}@example.test")
    with SessionLocal() as session:
        run = CliAgentRun(
            user_id=int(user.id), request_id=str(uuid4()), tier="lite", max_steps=8,
            task_hash="a" * 64, status="running", expires_at=utc_now(),
        )
        # Use a future expiration without depending on the route's configured
        # lifetime; this test is about PostgreSQL reservation semantics.
        from datetime import timedelta
        run.expires_at = utc_now() + timedelta(minutes=5)
        session.add(run)
        session.commit()
        session.refresh(run)
        run_id = run.id

    def reserve_one() -> None:
        with SessionLocal() as session:
            locked = session.exec(select(CliAgentRun).where(CliAgentRun.id == run_id).with_for_update()).one()
            current = locked.current_step
            time.sleep(0.05)
            locked.current_step = current + 1
            session.add(locked)
            session.commit()

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _item: reserve_one(), range(2)))
    with SessionLocal() as session:
        assert session.get(CliAgentRun, run_id).current_step == 2
