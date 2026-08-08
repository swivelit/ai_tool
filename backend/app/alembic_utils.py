from __future__ import annotations

from pathlib import Path


def repository_alembic_head() -> str | None:
    """Return the repository's single Alembic head without duplicating its ID."""
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        backend_root = Path(__file__).resolve().parents[1]
        script = ScriptDirectory.from_config(Config(str(backend_root / "alembic.ini")))
        heads = tuple(script.get_heads())
        return heads[0] if len(heads) == 1 else None
    except Exception:
        return None
