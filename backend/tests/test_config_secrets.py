from __future__ import annotations

import re
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
