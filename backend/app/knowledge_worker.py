from __future__ import annotations

import logging
import signal
import threading
from typing import Any, Callable

from sqlmodel import Session

from .database import engine
from .job_queue import DBJobQueue
from .web_ai.knowledge_embedding import (
    build_tracked_knowledge_embedding_provider,
)
from .web_ai.knowledge_jobs import KNOWLEDGE_JOB_TYPES
from .web_ai.settings import TriagConfigurationError, TriagSettings


logger = logging.getLogger(__name__)
ProviderFactory = Callable[[Session, dict[str, object]], Any]


def build_knowledge_worker_queues(
    database_engine: Any,
    settings: TriagSettings,
    *,
    provider_factory: ProviderFactory = build_tracked_knowledge_embedding_provider,
) -> tuple[DBJobQueue, ...]:
    """Build claim-isolated workers without starting API runtime services."""

    if not settings.knowledge_worker_enabled:
        return ()
    return tuple(
        DBJobQueue(
            database_engine,
            poll_seconds=settings.knowledge_worker_poll_seconds,
            allowed_job_types=KNOWLEDGE_JOB_TYPES,
            knowledge_embedding_provider_factory=provider_factory,
            chain_knowledge_jobs=True,
        )
        for _ in range(settings.knowledge_worker_max_concurrency)
    )


def run_knowledge_worker(stop_event: threading.Event | None = None) -> int:
    """Run the private knowledge worker until SIGINT/SIGTERM."""

    try:
        settings = TriagSettings.from_environ()
    except TriagConfigurationError:
        logger.error("knowledge worker configuration is invalid")
        return 2
    shutdown = stop_event or threading.Event()
    if stop_event is None:
        _install_signal_handlers(shutdown)
    queues = build_knowledge_worker_queues(engine, settings)
    if not queues:
        logger.info("knowledge worker is disabled")
        shutdown.wait()
        return 0
    logger.info("knowledge worker started")
    for queue in queues:
        queue.start()
    try:
        shutdown.wait()
    finally:
        for queue in queues:
            queue.stop()
        logger.info("knowledge worker stopped")
    return 0


def _install_signal_handlers(stop_event: threading.Event) -> None:
    def request_shutdown(_signum: int, _frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    return run_knowledge_worker()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
