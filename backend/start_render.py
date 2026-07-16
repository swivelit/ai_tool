from __future__ import annotations

import atexit
import logging
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Optional

import uvicorn

from app.production_config import ProductionConfigurationError, validate_production_configuration

BACKEND_ROOT = Path(__file__).resolve().parent

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


def _is_production_environment() -> bool:
    value = os.getenv("APP_ENV", os.getenv("ENVIRONMENT", "development"))
    return str(value or "development").strip().lower() in {"prod", "production"}


def _require_migrations_before_startup() -> bool:
    return _env_bool(
        "REQUIRE_MIGRATIONS_BEFORE_STARTUP",
        True if _is_production_environment() else False,
    )


def _terminate_background_migration() -> None:
    global _migration_process
    process = _migration_process
    if process is not None and process.poll() is None:
        logger.warning("Stopping still-running Alembic migration process")
        process.terminate()


def _watch_background_migration(process: subprocess.Popen) -> None:
    global _migration_process
    return_code = process.wait()
    if _migration_process is process:
        _migration_process = None
    if return_code == 0:
        logger.info("migration_completed Alembic migrations completed successfully", extra={"event": "migration_completed"})
    else:
        logger.error(
            "migration_failed Alembic migrations exited with status %s",
            return_code,
            extra={"event": "migration_failed", "return_code": return_code},
        )


def _start_migrations_with_grace_period() -> None:
    global _migration_process

    if not _env_bool("RUN_MIGRATIONS_ON_STARTUP", True):
        if _require_migrations_before_startup():
            logger.error(
                "server_start_blocked_schema_not_ready RUN_MIGRATIONS_ON_STARTUP is disabled while migrations are required",
                extra={"event": "server_start_blocked_schema_not_ready"},
            )
            sys.exit(1)
        logger.info("RUN_MIGRATIONS_ON_STARTUP is disabled; skipping Alembic migrations")
        return

    production = _is_production_environment()
    command = [
        sys.executable,
        "-m",
        "alembic",
        "-c",
        str(BACKEND_ROOT / "alembic.ini"),
        "upgrade",
        "head",
    ]
    grace_seconds = _env_int("MIGRATION_STARTUP_GRACE_SECONDS", 120 if production else 15)
    require_before_startup = _require_migrations_before_startup()
    timeout_seconds = _env_int(
        "MIGRATION_STARTUP_TIMEOUT_SECONDS",
        120 if production else (grace_seconds if grace_seconds > 0 else 120),
    )

    logger.info(
        "migration_started Starting Alembic migrations: %s",
        " ".join(command),
        extra={
            "event": "migration_started",
            "require_before_startup": require_before_startup,
            "timeout_seconds": timeout_seconds if require_before_startup else grace_seconds,
        },
    )

    try:
        process = subprocess.Popen(command, cwd=BACKEND_ROOT)
    except BaseException:
        logger.exception("migration_failed Could not start Alembic migrations", extra={"event": "migration_failed"})
        sys.exit(1)

    _migration_process = process
    atexit.register(_terminate_background_migration)

    if require_before_startup:
        try:
            return_code = process.wait(timeout=max(1, timeout_seconds))
        except subprocess.TimeoutExpired:
            logger.error(
                "migration_timeout Alembic migrations did not finish within %s seconds",
                timeout_seconds,
                extra={"event": "migration_timeout", "timeout_seconds": timeout_seconds},
            )
            process.terminate()
            _migration_process = None
            logger.error(
                "server_start_blocked_schema_not_ready Migration timeout blocked server startup",
                extra={"event": "server_start_blocked_schema_not_ready"},
            )
            sys.exit(124)

        if return_code == 0:
            _migration_process = None
            logger.info(
                "migration_completed Alembic migrations completed before web startup",
                extra={"event": "migration_completed"},
            )
            return

        logger.error(
            "migration_failed Alembic migrations failed before web startup with status %s",
            return_code,
            extra={"event": "migration_failed", "return_code": return_code},
        )
        logger.error(
            "server_start_blocked_schema_not_ready Migration failure blocked server startup",
            extra={"event": "server_start_blocked_schema_not_ready"},
        )
        _migration_process = None
        sys.exit(return_code or 1)

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
        _migration_process = None
        logger.info("migration_completed Alembic migrations completed before web startup", extra={"event": "migration_completed"})
        return

    logger.error(
        "migration_failed Alembic migrations failed before web startup with status %s",
        return_code,
        extra={"event": "migration_failed", "return_code": return_code},
    )
    _migration_process = None
    sys.exit(return_code)


def main() -> None:
    host = os.getenv("HOST", "0.0.0.0")
    port = _env_int("PORT", 10000)

    # In production, Alembic owns schema changes.
    # Runtime create_all() is only for local SQLite/dev.
    os.environ.setdefault("AUTO_CREATE_TABLES", "false")
    startup_failure_default = "true" if _is_production_environment() else "false"
    os.environ.setdefault("FAIL_STARTUP_ON_REQUIRED_SERVICE_ERROR", startup_failure_default)
    # Render's pre-deploy command owns production migrations. Running the same
    # migration again during HTTP startup creates a second failure mode and can
    # delay health checks.
    os.environ.setdefault("RUN_MIGRATIONS_ON_STARTUP", "false" if _is_production_environment() else "true")
    os.environ.setdefault("REQUIRE_MIGRATIONS_BEFORE_STARTUP", "false")

    if _is_production_environment():
        try:
            validate_production_configuration()
        except ProductionConfigurationError as exc:
            logger.error("production_configuration_invalid %s", exc)
            sys.exit(78)

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
