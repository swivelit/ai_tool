from __future__ import annotations
import hashlib
import json
import os
import secrets
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse

ENGINE_COMMIT = "03d49d0c7de095a41628a74d94a146214f82837a"
TEMPLATES = ("couple-01", "couple-02")


def root() -> Path:
    return Path(os.environ.get("SWICO_VIDEO_DATA_DIR", str(Path.home() / "Library/Application Support/SwicoVideo"))).expanduser().resolve()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def read(path: Path):
    return json.loads(path.read_text())


def atomic(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temp = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def confined(path: Path, parent: Path) -> Path:
    if path.is_symlink() or not path.resolve().is_relative_to(parent.resolve()):
        raise ValueError("Path escapes owned video storage")
    return path.resolve()


def template_dir(template: str) -> Path:
    if template not in TEMPLATES:
        raise ValueError("Unknown template ID")
    return confined(root() / "templates" / template, root())


def init(worker_id: str, api_base: str):
    url = urlparse(api_base)
    if worker_id != "intel-mac-01" or url.scheme != "https" or not url.hostname or url.username or url.query or url.fragment or url.path not in {"", "/"}:
        raise ValueError("Use intel-mac-01 and an HTTPS API origin without credentials")
    os.umask(0o077)
    for name in ("templates", "rights", "jobs", "logs", "engine"):
        (root() / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    token_file = root() / "worker.token"
    if not token_file.exists():
        fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(secrets.token_urlsafe(48))
    if token_file.is_symlink() or token_file.stat().st_mode & 0o077:
        raise ValueError("Worker token must have mode 0600")
    config = root() / "config.json"
    if config.exists() and (read(config).get("worker_id") != worker_id or read(config).get("api_base") != api_base.rstrip("/")):
        raise ValueError("Existing worker configuration differs; stop/review it explicitly instead of silently replacing credentials")
    if not config.exists():
        atomic(config, {"worker_id": worker_id, "api_base": api_base.rstrip("/"), "profile": "quality-cpu"})
    from .models import skeleton
    if not (root() / "models.json").exists():
        atomic(root() / "models.json", skeleton())
    print(digest(token_file.read_bytes()))  # ONLY the digest, never the token.


def cleanup_jobs():
    # On startup no attempt is owned yet. Delete only UUID-named owned job dirs.
    import uuid
    for path in (root() / "jobs").iterdir():
        try:
            uuid.UUID(path.name)
        except ValueError:
            continue
        confined(path, root() / "jobs")
        if path.is_dir():
            shutil.rmtree(path)


def rotate_token():
    import fcntl
    with (root()/"worker.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fd, temporary = tempfile.mkstemp(dir=root(), prefix=".token-")
        token = secrets.token_urlsafe(48).encode()
        with os.fdopen(fd, "wb") as stream:
            stream.write(token); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, root()/"worker.token")
        print(digest(token))
