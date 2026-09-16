"""Bounded, secret-aware snapshot manifest construction for runner handoff."""
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import os

EXCLUDED_NAMES = {".git", ".env", ".env.local", ".env.production", ".npmrc", ".pypirc", "node_modules", "dist", "build", ".swico"}
EXCLUDED_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".kdbx")


class SnapshotError(ValueError):
    pass


def _excluded(relative: str) -> bool:
    parts = relative.replace(os.sep, "/").split("/")
    return any(part in EXCLUDED_NAMES or part.lower().endswith(EXCLUDED_SUFFIXES) for part in parts)


def create_snapshot_manifest(root: str | Path, *, max_files: int = 5_000, max_bytes: int = 50 * 1024 * 1024) -> dict[str, object]:
    base = Path(root).resolve()
    if not base.is_dir() or base.is_symlink(): raise SnapshotError("snapshot root must be a real directory")
    files: list[dict[str, object]] = []; total = 0
    for current, directories, names in os.walk(base, topdown=True, followlinks=False):
        current_path = Path(current)
        directories[:] = [name for name in directories if not _excluded(str((current_path / name).relative_to(base))) and not (current_path / name).is_symlink()]
        for name in sorted(names):
            path = current_path / name; relative = str(path.relative_to(base)).replace(os.sep, "/")
            if _excluded(relative) or path.is_symlink(): continue
            try: data = path.read_bytes()
            except OSError as exc: raise SnapshotError(f"snapshot file cannot be read: {relative}") from exc
            total += len(data)
            if len(files) >= max_files or total > max_bytes: raise SnapshotError("snapshot exceeds file or byte bounds")
            files.append({"path": relative, "size": len(data), "sha256": sha256(data).hexdigest()})
    return {"version": 1, "file_count": len(files), "total_bytes": total, "files": files}
