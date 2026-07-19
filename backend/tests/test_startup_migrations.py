from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

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


def test_swico_tier_migration_upgrades_from_preceding_revision(tmp_path):
    db_path = tmp_path / "swico-tier-upgrade.sqlite3"
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite:///{db_path.as_posix()}"
    env["APP_ENV"] = "test"
    env["AUTO_CREATE_TABLES"] = "false"
    preceding = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "8c1f4e7b2a90"],
        cwd=BACKEND_ROOT, env=env, text=True, capture_output=True, timeout=30,
    )
    assert preceding.returncode == 0, preceding.stderr
    before = inspect(create_engine(env["DATABASE_URL"]))
    assert "assistant_tier" not in {
        column["name"] for column in before.get_columns("web_usage_preferences")
    }

    upgraded = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_ROOT, env=env, text=True, capture_output=True, timeout=30,
    )
    assert upgraded.returncode == 0, upgraded.stderr
    after = inspect(create_engine(env["DATABASE_URL"]))
    assert "assistant_tier" in {
        column["name"] for column in after.get_columns("web_usage_preferences")
    }
    assert "swico_tier" in {
        column["name"] for column in after.get_columns("web_chat_message")
    }
    assert "swico_tier" in {
        column["name"] for column in after.get_columns("usage_charge")
    }
    assert "billing_exemption_reason" in {
        column["name"] for column in after.get_columns("usage_charge")
    }


def test_voice_usage_migration_backfills_chat_and_downgrades_additively(tmp_path):
    db_path = tmp_path / "voice-usage-upgrade.sqlite3"
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite:///{db_path.as_posix()}"
    env["APP_ENV"] = "test"
    env["AUTO_CREATE_TABLES"] = "false"
    preceding = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "a7c4e9d2f1b6"],
        cwd=BACKEND_ROOT, env=env, text=True, capture_output=True, timeout=30,
    )
    assert preceding.returncode == 0, preceding.stderr
    engine = create_engine(env["DATABASE_URL"])
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO user (id,name,timezone,assistant_name,reply_language,created_at) "
            "VALUES (1,'Legacy','Asia/Kolkata','Elli','en',CURRENT_TIMESTAMP)"
        ))
        connection.execute(text(
            "INSERT INTO usage_charge "
            "(id, request_id, user_id, provider, model, status, created_at) "
            "VALUES ('legacy-charge', 'legacy-request', 1, 'openai', 'legacy-model', "
            "'settled', CURRENT_TIMESTAMP)"
        ))
    upgraded = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_ROOT, env=env, text=True, capture_output=True, timeout=30,
    )
    assert upgraded.returncode == 0, upgraded.stderr
    columns = {column["name"] for column in inspect(engine).get_columns("usage_charge")}
    assert {"usage_kind", "voice_turn_id", "audio_milliseconds", "characters"}.issubset(columns)
    with engine.connect() as connection:
        row = connection.execute(text(
            "SELECT usage_kind, audio_milliseconds, characters, request_id "
            "FROM usage_charge WHERE id = 'legacy-charge'"
        )).mappings().one()
    assert dict(row) == {
        "usage_kind": "chat", "audio_milliseconds": 0,
        "characters": 0, "request_id": "legacy-request",
    }
    downgraded = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "a7c4e9d2f1b6"],
        cwd=BACKEND_ROOT, env=env, text=True, capture_output=True, timeout=30,
    )
    assert downgraded.returncode == 0, downgraded.stderr
    remaining = {column["name"] for column in inspect(engine).get_columns("usage_charge")}
    assert not {"usage_kind", "voice_turn_id", "audio_milliseconds", "characters"} & remaining


def test_credit_bucket_migration_preserves_legacy_money_and_downgrades(tmp_path):
    db_path = tmp_path / "credit-buckets.sqlite3"
    env = os.environ.copy()
    env.update({
        "DATABASE_URL": f"sqlite:///{db_path.as_posix()}",
        "APP_ENV": "test", "AUTO_CREATE_TABLES": "false",
    })
    preceding = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "c5d8a2e9f4b1"],
        cwd=BACKEND_ROOT, env=env, text=True, capture_output=True, timeout=30,
    )
    assert preceding.returncode == 0, preceding.stderr
    engine = create_engine(env["DATABASE_URL"])
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO user (id,name,timezone,assistant_name,reply_language,created_at) "
            "VALUES (77,'Legacy','Asia/Kolkata','Elli','en',CURRENT_TIMESTAMP)"
        ))
        connection.execute(text(
            "INSERT INTO wallet_account (id,user_id,balance_micros,reserved_micros,version,created_at,updated_at) "
            "VALUES ('legacy-wallet',77,123456789,0,4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
        ))
        connection.execute(text(
            "INSERT INTO wallet_ledger (id,user_id,entry_type,amount_micros,balance_after_micros,reference_type,reference_id,idempotency_key,created_at) "
            "VALUES ('legacy-ledger',77,'payment_credit',123456789,123456789,'payment_order','legacy-order','legacy-key',CURRENT_TIMESTAMP)"
        ))
        connection.execute(text(
            "INSERT INTO payment_order (id,user_id,receipt,gross_amount_paise,credited_amount_micros,platform_share_paise,status,created_at,updated_at) "
            "VALUES ('legacy-order',77,'legacy-receipt',1000,5000000,500,'credited',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
        ))
        connection.execute(text(
            "INSERT INTO usage_charge (id,request_id,user_id,provider,model,status,created_at,usage_kind) "
            "VALUES ('legacy-usage','legacy-usage-request',77,'sarvam','saaras:v3','settled',CURRENT_TIMESTAMP,'stt')"
        ))
    upgraded = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND_ROOT,
        env=env, text=True, capture_output=True, timeout=30,
    )
    assert upgraded.returncode == 0, upgraded.stderr
    with engine.connect() as connection:
        wallet = connection.execute(text(
            "SELECT balance_micros, credit_bucket FROM wallet_account WHERE id='legacy-wallet'"
        )).mappings().one()
        assert dict(wallet) == {"balance_micros": 123456789, "credit_bucket": "chat"}
        for table, row_id in (("wallet_ledger", "legacy-ledger"), ("payment_order", "legacy-order"), ("usage_charge", "legacy-usage")):
            assert connection.execute(text(
                f"SELECT credit_bucket FROM {table} WHERE id=:row_id"
            ), {"row_id": row_id}).scalar_one() == "chat"
        assert connection.execute(text(
            "SELECT COUNT(*) FROM wallet_account WHERE user_id=77 AND credit_bucket='voice'"
        )).scalar_one() == 0
    unique = inspect(engine).get_unique_constraints("wallet_account")
    assert any(item["column_names"] == ["user_id", "credit_bucket"] for item in unique)
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO wallet_account (id,user_id,credit_bucket,balance_micros,reserved_micros,version,created_at,updated_at) "
            "VALUES ('voice-wallet',77,'voice',0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
        ))
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO wallet_account (id,user_id,credit_bucket,balance_micros,reserved_micros,version,created_at,updated_at) "
            "VALUES ('duplicate-voice-wallet',77,'voice',0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
        ))
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO wallet_account (id,user_id,credit_bucket,balance_micros,reserved_micros,version,created_at,updated_at) "
            "VALUES ('invalid-wallet',77,'other',0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
        ))
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO payment_order "
            "(id,user_id,receipt,gross_amount_paise,credited_amount_micros,platform_share_paise,status,credit_bucket,created_at,updated_at) "
            "VALUES ('voice-order',77,'voice-receipt',1000,5000000,500,'created','voice',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
        ))
    refused = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "c5d8a2e9f4b1"], cwd=BACKEND_ROOT,
        env=env, text=True, capture_output=True, timeout=30,
    )
    assert refused.returncode != 0
    assert "Refusing to downgrade credit buckets" in refused.stderr
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM payment_order WHERE id='voice-order'"))
    downgraded = subprocess.run(
        [sys.executable, "-m", "alembic", "downgrade", "c5d8a2e9f4b1"], cwd=BACKEND_ROOT,
        env=env, text=True, capture_output=True, timeout=30,
    )
    assert downgraded.returncode == 0, downgraded.stderr
    assert "credit_bucket" not in {column["name"] for column in inspect(engine).get_columns("wallet_account")}
    with engine.connect() as connection:
        assert connection.execute(text(
            "SELECT balance_micros FROM wallet_account WHERE id='legacy-wallet'"
        )).scalar_one() == 123456789


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
