from __future__ import annotations

import atexit
import logging
import os
import subprocess
import sys
import threading
from typing import Optional

import uvicorn

LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format=LOG_FORMAT)
logger = logging.getLogger("render-start")

_migration_process: Optional[subprocess.Popen] = None


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or not value.strip():
        return default
    try:
        return int(value)
    except ValueError:
        logger.warning("Invalid integer for %s=%r; using %s", name, value, default)
        return default


def _terminate_background_migration() -> None:
    global _migration_process
    process = _migration_process
    if process is not None and process.poll() is None:
        logger.warning("Stopping still-running Alembic migration process")
        process.terminate()


def _watch_background_migration(process: subprocess.Popen) -> None:
    return_code = process.wait()
    if return_code == 0:
        logger.info("Alembic migrations completed successfully")
    else:
        logger.error("Alembic migrations exited with status %s", return_code)


def _start_migrations_with_grace_period() -> None:
    global _migration_process

    if not _env_bool("RUN_MIGRATIONS_ON_STARTUP", True):
        logger.info("RUN_MIGRATIONS_ON_STARTUP is disabled; skipping Alembic migrations")
        return

    command = [sys.executable, "-m", "alembic", "upgrade", "head"]
    grace_seconds = _env_int("MIGRATION_STARTUP_GRACE_SECONDS", 15)

    logger.info("Starting Alembic migrations: %s", " ".join(command))

    try:
        process = subprocess.Popen(command)
    except BaseException:
        logger.exception("Could not start Alembic migrations")
        sys.exit(1)

    _migration_process = process
    atexit.register(_terminate_background_migration)

    if grace_seconds <= 0:
        logger.info("Not waiting for migrations because MIGRATION_STARTUP_GRACE_SECONDS=%s", grace_seconds)
        threading.Thread(
            target=_watch_background_migration,
            args=(process,),
            name="alembic-upgrade-watch",
            daemon=True,
        ).start()
        return

    try:
        return_code = process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        logger.warning(
            "Alembic migrations are still running after %s seconds. "
            "Starting the web server now so Render can detect the HTTP port.",
            grace_seconds,
        )
        threading.Thread(
            target=_watch_background_migration,
            args=(process,),
            name="alembic-upgrade-watch",
            daemon=True,
        ).start()
        return

    if return_code == 0:
        logger.info("Alembic migrations completed before web startup")
        return

    logger.error("Alembic migrations failed before web startup with status %s", return_code)
    sys.exit(return_code)


def main() -> None:
    host = os.getenv("HOST", "0.0.0.0")
    port = _env_int("PORT", 10000)

    # In production, Alembic owns schema changes.
    # Runtime create_all() is only for local SQLite/dev.
    os.environ.setdefault("AUTO_CREATE_TABLES", "false")
    os.environ.setdefault("FAIL_STARTUP_ON_REQUIRED_SERVICE_ERROR", "false")

    _start_migrations_with_grace_period()

    logger.info("Starting Uvicorn on %s:%s", host, port)
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        log_level=os.getenv("UVICORN_LOG_LEVEL", os.getenv("LOG_LEVEL", "info")).lower(),
        proxy_headers=True,
        forwarded_allow_ips=os.getenv("FORWARDED_ALLOW_IPS", "*"),
    )


if __name__ == "__main__":
    main()