from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect

import start_render


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REQUIRED_GLOBAL_QA_TABLES = {
    "agent_run",
    "agent_step",
    "document_artifact",
    "global_qa_cache",
    "global_qa_observation",
    "global_qa_tombstone",
    "openai_usage_log",
}


def test_repair_migration_runs_on_empty_db_and_creates_required_tables(tmp_path):
    db_path = tmp_path / "repair-empty.sqlite3"
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite:///{db_path.as_posix()}"
    env["APP_ENV"] = "test"
    env["AUTO_CREATE_TABLES"] = "false"

    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    inspector = inspect(create_engine(env["DATABASE_URL"]))
    assert REQUIRED_GLOBAL_QA_TABLES.issubset(set(inspector.get_table_names()))


class _FailingMigrationProcess:
    def __init__(self, return_code: int):
        self.return_code = return_code
        self.terminated = False

    def wait(self, timeout=None):
        return self.return_code

    def poll(self):
        return self.return_code

    def terminate(self):
        self.terminated = True


class _TimeoutMigrationProcess:
    terminated = False

    def wait(self, timeout=None):
        raise subprocess.TimeoutExpired(cmd="alembic", timeout=timeout)

    def poll(self):
        return None

    def terminate(self):
        self.terminated = True


def _production_migration_env(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("RUN_MIGRATIONS_ON_STARTUP", "true")
    monkeypatch.setenv("REQUIRE_MIGRATIONS_BEFORE_STARTUP", "true")
    monkeypatch.setenv("MIGRATION_STARTUP_TIMEOUT_SECONDS", "1")


def test_start_render_blocks_production_startup_when_migrations_fail(monkeypatch, caplog):
    _production_migration_env(monkeypatch)
    process = _FailingMigrationProcess(return_code=7)
    popen_calls = []

    def fake_popen(command, cwd=None):
        popen_calls.append({"command": command, "cwd": cwd})
        return process

    monkeypatch.setattr(start_render.subprocess, "Popen", fake_popen)

    with caplog.at_level("ERROR"), pytest.raises(SystemExit) as exc:
        start_render._start_migrations_with_grace_period()

    assert exc.value.code == 7
    assert popen_calls
    assert popen_calls[0]["cwd"] == start_render.BACKEND_ROOT
    assert popen_calls[0]["command"][0] == sys.executable
    assert popen_calls[0]["command"][1:4] == ["-m", "alembic", "-c"]
    assert popen_calls[0]["command"][4] == str(start_render.BACKEND_ROOT / "alembic.ini")
    assert popen_calls[0]["command"][5:] == ["upgrade", "head"]
    assert "migration_failed" in caplog.text
    assert "server_start_blocked_schema_not_ready" in caplog.text


def test_start_render_blocks_production_startup_when_migrations_timeout(monkeypatch, caplog):
    _production_migration_env(monkeypatch)
    process = _TimeoutMigrationProcess()
    monkeypatch.setattr(start_render.subprocess, "Popen", lambda command, cwd=None: process)

    with caplog.at_level("ERROR"), pytest.raises(SystemExit) as exc:
        start_render._start_migrations_with_grace_period()

    assert exc.value.code == 124
    assert process.terminated is True
    assert "migration_timeout" in caplog.text
    assert "server_start_blocked_schema_not_ready" in caplog.text


def test_start_render_production_migration_defaults_are_120_seconds(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("RUN_MIGRATIONS_ON_STARTUP", "true")
    monkeypatch.setenv("REQUIRE_MIGRATIONS_BEFORE_STARTUP", "true")
    monkeypatch.delenv("MIGRATION_STARTUP_GRACE_SECONDS", raising=False)
    monkeypatch.delenv("MIGRATION_STARTUP_TIMEOUT_SECONDS", raising=False)

    process = _FailingMigrationProcess(return_code=0)
    waits = []

    def wait_with_capture(timeout=None):
        waits.append(timeout)
        return 0

    process.wait = wait_with_capture
    monkeypatch.setattr(start_render.subprocess, "Popen", lambda command, cwd=None: process)

    start_render._start_migrations_with_grace_period()

    assert waits == [120]
