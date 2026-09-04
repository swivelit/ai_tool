from __future__ import annotations

from pathlib import Path
from typing import Any


def repository_alembic_script() -> Any | None:
    """Return the repository Alembic script directory, or None if unavailable."""
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        backend_root = Path(__file__).resolve().parents[1]
        return ScriptDirectory.from_config(Config(str(backend_root / "alembic.ini")))
    except Exception:
        return None


def repository_alembic_head() -> str | None:
    """Return the repository's single Alembic head without duplicating its ID."""
    script = repository_alembic_script()
    if script is None:
        return None
    try:
        heads = tuple(script.get_heads())
        return heads[0] if len(heads) == 1 else None
    except Exception:
        return None


def repository_alembic_revision_is_ancestor(
    required_revision: str,
    current_revision: str,
) -> bool:
    """Check revision ancestry using Alembic's migration graph."""
    if not required_revision or not current_revision:
        return False
    script = repository_alembic_script()
    if script is None:
        return False
    try:
        if required_revision == current_revision:
            return script.get_revision(current_revision) is not None
        return any(
            revision.revision == required_revision
            or required_revision in (
                set(revision.down_revision)
                if isinstance(revision.down_revision, tuple)
                else {revision.down_revision}
            )
            for revision in script.iterate_revisions(
                current_revision, required_revision,
            )
        )
    except Exception:
        # Release checks must fail closed for unknown or malformed revisions.
        return False
