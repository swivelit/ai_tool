from __future__ import annotations

import re
import importlib
from pathlib import Path
from urllib.parse import urlsplit


POSTGRES_URL_RE = re.compile(r"\bpostgres(?:ql)?(?:\+[A-Za-z0-9_]+)?://[^\s]+")


def _is_passworded_postgres_url(value: str) -> bool:
    parsed = urlsplit(value.strip())
    scheme = parsed.scheme.split("+", 1)[0]
    return scheme in {"postgres", "postgresql"} and bool(parsed.password)


def test_alembic_ini_does_not_contain_passworded_postgres_url() -> None:
    alembic_ini = Path(__file__).resolve().parents[1] / "alembic.ini"

    for line in alembic_ini.read_text(encoding="utf-8").splitlines():
        for match in POSTGRES_URL_RE.finditer(line):
            assert not _is_passworded_postgres_url(match.group(0))


def test_production_observability_omits_chat_previews_by_default(monkeypatch) -> None:
    import app.observability as observability

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("LOG_CHAT_CONTENT", raising=False)
    reloaded = importlib.reload(observability)
    try:
        payload = reloaded.chat_log_payload(question="secret question", answer="secret answer", text="tts secret")

        assert payload["question_hash"]
        assert payload["answer_hash"]
        assert payload["question_length"] == len("secret question")
        assert "question_preview" not in payload
        assert "answer_preview" not in payload
        assert "text_preview" not in payload
    finally:
        monkeypatch.setenv("APP_ENV", "test")
        monkeypatch.delenv("LOG_CHAT_CONTENT", raising=False)
        importlib.reload(observability)


def test_observability_previews_require_explicit_flag(monkeypatch) -> None:
    import app.observability as observability

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("LOG_CHAT_CONTENT", "true")
    reloaded = importlib.reload(observability)
    try:
        payload = reloaded.chat_log_payload(question="visible question", answer="visible answer", text="visible tts")

        assert payload["question_preview"] == "visible question"
        assert payload["answer_preview"] == "visible answer"
        assert payload["text_preview"] == "visible tts"
    finally:
        monkeypatch.setenv("APP_ENV", "test")
        monkeypatch.delenv("LOG_CHAT_CONTENT", raising=False)
        importlib.reload(observability)
