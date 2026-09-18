"""Private, local rights-evidence handling.

This module deliberately treats evidence as operator supplied bytes.  It does
not interpret licences, contact a provider, download model weights, or make a
legal conclusion.  Only hashes and bounded metadata leave this module.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
import os
import re
import stat
import tempfile
import uuid
from pathlib import Path

from .storage import atomic, confined, hash_file, root

MIN_EVIDENCE_BYTES = 20
MAX_EVIDENCE_BYTES = 10 * 1024 * 1024
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
NAME_RE = re.compile(r"^[a-z][a-z0-9_.-]{0,80}\Z")


class EvidenceError(ValueError):
    """A bounded public reason code; never includes a source path or content."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _rights_dir() -> Path:
    directory = root() / "rights"
    if os.path.lexists(directory) and directory.is_symlink():
        raise EvidenceError("evidence_destination_conflict")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    return directory


def _validate_label(value: str, *, code: str = "evidence_metadata_invalid") -> str:
    if not isinstance(value, str):
        raise EvidenceError(code)
    value = value.strip()
    if not value or len(value) > 160 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise EvidenceError(code)
    return value


def validate_review_metadata(reviewer: str, reviewed_at: str) -> tuple[str, str]:
    reviewer = _validate_label(reviewer)
    if not isinstance(reviewed_at, str) or not DATE_RE.fullmatch(reviewed_at):
        raise EvidenceError("evidence_date_invalid")
    try:
        date.fromisoformat(reviewed_at)
    except ValueError:
        raise EvidenceError("evidence_date_invalid") from None
    return reviewer, reviewed_at


def _read_source(source_name: str) -> bytes:
    """Read a regular, non-symlink local file into bounded private memory."""
    try:
        source = Path(source_name).expanduser()
        absolute = Path(os.path.abspath(source))
        if any(part.is_symlink() for part in (absolute, *absolute.parents)):
            raise EvidenceError("evidence_source_symlink")
        resolved = absolute.resolve(strict=True)
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode):
            raise EvidenceError("evidence_source_not_regular")
        if info.st_size < MIN_EVIDENCE_BYTES or info.st_size > MAX_EVIDENCE_BYTES:
            raise EvidenceError("evidence_source_size_invalid")
        with resolved.open("rb") as stream:
            data = stream.read(MAX_EVIDENCE_BYTES + 1)
        if len(data) != info.st_size or len(data) > MAX_EVIDENCE_BYTES:
            raise EvidenceError("evidence_source_changed")
        if not any(byte not in b" \t\r\n\x00" for byte in data):
            raise EvidenceError("evidence_source_empty")
        return data
    except EvidenceError:
        raise
    except (OSError, RuntimeError, ValueError):
        raise EvidenceError("evidence_source_missing") from None


def _scope(scope: str) -> Path:
    if not isinstance(scope, str) or not NAME_RE.fullmatch(scope):
        raise EvidenceError("evidence_scope_invalid")
    evidence_root = _rights_dir() / "evidence"
    if os.path.lexists(evidence_root) and evidence_root.is_symlink():
        raise EvidenceError("evidence_destination_conflict")
    evidence_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(evidence_root, 0o700)
    directory = evidence_root / scope
    if os.path.lexists(directory) and directory.is_symlink():
        raise EvidenceError("evidence_destination_conflict")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    return directory


def _relative(path: Path) -> str:
    return path.relative_to(_rights_dir()).as_posix()


def store_document(source_name: str, scope: str) -> tuple[str, str, bool]:
    """Copy evidence by content hash and return (relative name, hash, created)."""
    data = _read_source(source_name)
    import hashlib

    file_hash = hashlib.sha256(data).hexdigest()
    directory = _scope(scope)
    destination = directory / file_hash
    if destination.exists() or os.path.lexists(destination):
        try:
            if destination.is_symlink() or not destination.is_file() or hash_file(destination) != file_hash:
                raise EvidenceError("evidence_destination_conflict")
        except OSError:
            raise EvidenceError("evidence_destination_conflict") from None
        os.chmod(destination, 0o600)
        return _relative(destination), file_hash, False

    descriptor, temporary = tempfile.mkstemp(prefix=".evidence-", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        try:
            # Hard-link publication is no-replace on the same private volume.
            os.link(temporary, destination)
        except FileExistsError:
            if destination.is_symlink() or not destination.is_file() or hash_file(destination) != file_hash:
                raise EvidenceError("evidence_destination_conflict") from None
            return _relative(destination), file_hash, False
        return _relative(destination), file_hash, True
    except EvidenceError:
        raise
    except (OSError, ValueError):
        raise EvidenceError("evidence_store_failed") from None
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def remove_created(relative_names: list[str]) -> None:
    rights = _rights_dir()
    for name in relative_names:
        try:
            path = confined(rights / name, rights)
            if path.is_file() and not path.is_symlink():
                path.unlink()
            parent = path.parent
            while parent != rights and parent.is_dir():
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
        except (OSError, ValueError):
            # Rollback is best effort and never follows a path outside rights.
            continue


def backup_json(path: Path, label: str) -> str | None:
    """Make a private timestamped byte backup before replacing existing JSON."""
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise EvidenceError("evidence_manifest_invalid")
    if not NAME_RE.fullmatch(label):
        raise EvidenceError("evidence_scope_invalid")
    backups = _rights_dir() / "backups"
    if os.path.lexists(backups) and backups.is_symlink():
        raise EvidenceError("evidence_destination_conflict")
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(backups, 0o700)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    destination = backups / f"{label}-{timestamp}-{uuid.uuid4().hex[:12]}.json"
    descriptor, temporary = tempfile.mkstemp(prefix=".backup-", dir=backups)
    try:
        with os.fdopen(descriptor, "wb") as stream, path.open("rb") as source:
            data = source.read(MAX_EVIDENCE_BYTES + 1)
            if len(data) > MAX_EVIDENCE_BYTES:
                raise EvidenceError("evidence_backup_failed")
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        return destination.name
    except EvidenceError:
        raise
    except (OSError, ValueError):
        raise EvidenceError("evidence_backup_failed") from None
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def evidence_file_status(record: dict, field: str) -> dict:
    name = record.get(field + "_file")
    expected = record.get(field + "_sha256")
    result = {"field": field, "stored": bool(name), "hash_recorded": bool(expected)}
    if not name or not expected:
        result["status"] = "missing"
        return result
    try:
        path = confined(_rights_dir() / name, _rights_dir())
        result["stored_name"] = path.name
        result["status"] = "verified" if path.is_file() and not path.is_symlink() and hash_file(path) == expected else "invalid"
    except (OSError, ValueError):
        result["status"] = "invalid"
    return result


def update_json_with_backup(path: Path, value: dict, label: str) -> str | None:
    backup = backup_json(path, label)
    atomic(path, value)
    return backup
