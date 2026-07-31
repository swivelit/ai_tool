from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import PurePath
import re

from ..web_ai.code_quality.repository_index import (
    RepositorySourceFile,
    source_file,
)
from .upload_store import EphemeralUploadStore


REPOSITORY_KEY_PREFIX = "swico:web-repository:v1:"
_UNSAFE_DISPLAY_NAME = re.compile(r"[\x00-\x1f\x7f]")


def safe_repository_display_name(value: str) -> str:
    basename = PurePath(str(value or "").replace("\\", "/")).name
    cleaned = _UNSAFE_DISPLAY_NAME.sub("", basename).strip()
    if not cleaned.casefold().endswith(".zip"):
        return "Repository.zip"
    return cleaned[:128] or "Repository.zip"


@dataclass(frozen=True)
class EphemeralRepositorySnapshot:
    id: str
    owner_user_id: int
    source_version: str
    content_hash: str
    created_at: str
    expires_at: str
    files: tuple[RepositorySourceFile, ...]
    display_name: str = "Repository.zip"

    def safe_metadata(self) -> dict[str, object]:
        return {
            "id": self.id,
            "source_version": self.source_version,
            "content_hash": self.content_hash,
            "file_count": len(self.files),
            "display_name": self.display_name,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
        }


def repository_store_key(owner_user_id: int, repository_id: str) -> str:
    return f"{REPOSITORY_KEY_PREFIX}{owner_user_id}:{repository_id}"


def _expired(value: str) -> bool:
    try:
        expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return True
    return expiry <= datetime.now(timezone.utc)


def put_repository_snapshot(
    store: EphemeralUploadStore,
    snapshot: EphemeralRepositorySnapshot,
    *,
    ttl_seconds: int,
) -> None:
    payload = asdict(snapshot)
    store.set_auxiliary(
        repository_store_key(snapshot.owner_user_id, snapshot.id),
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        ttl_seconds,
    )


def get_repository_snapshot(
    store: EphemeralUploadStore,
    *,
    owner_user_id: int,
    repository_id: str,
) -> EphemeralRepositorySnapshot | None:
    value = store.get_auxiliary(
        repository_store_key(owner_user_id, repository_id)
    )
    if value is None:
        return None
    try:
        payload = json.loads(value)
        decoded_files = []
        for item in payload["files"]:
            decoded = source_file(str(item["path"]), str(item["text"]))
            if decoded.content_hash != str(item["content_hash"]):
                return None
            decoded_files.append(decoded)
        files = tuple(decoded_files)
        snapshot = EphemeralRepositorySnapshot(
            id=str(payload["id"]),
            owner_user_id=int(payload["owner_user_id"]),
            source_version=str(payload["source_version"]),
            content_hash=str(payload["content_hash"]),
            created_at=str(payload["created_at"]),
            expires_at=str(payload["expires_at"]),
            files=files,
            display_name=safe_repository_display_name(
                str(payload.get("display_name", "Repository.zip"))
            ),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None
    digest = hashlib.sha256()
    for item in sorted(snapshot.files, key=lambda value: value.path):
        digest.update(item.path.encode())
        digest.update(b"\0")
        digest.update(item.content_hash.encode())
    if (
        digest.hexdigest() != snapshot.content_hash
        or snapshot.source_version != snapshot.content_hash[:32]
    ):
        store.delete_auxiliary(repository_store_key(owner_user_id, repository_id))
        return None
    if snapshot.owner_user_id != owner_user_id or _expired(snapshot.expires_at):
        store.delete_auxiliary(repository_store_key(owner_user_id, repository_id))
        return None
    return snapshot
