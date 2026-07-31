from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from uuid import uuid4

from sqlmodel import Session, select
from sqlalchemy import update

from ..models import (
    WebCodeEdge,
    WebCodeFile,
    WebCodeRepository,
    WebCodeSymbol,
)
from ..web_ai.code_quality.repository_archive import (
    ArchiveLimits,
    inspect_repository_zip,
)
from ..web_ai.code_quality.repository_index import (
    RepositoryIndex,
    build_repository_index,
)
from .repository_store import (
    EphemeralRepositorySnapshot,
    put_repository_snapshot,
)
from .upload_store import EphemeralUploadStore, expiration_iso, utc_iso


def create_repository_snapshot(
    session: Session,
    *,
    store: EphemeralUploadStore,
    owner_user_id: int,
    repository_id: str,
    archive: bytes,
    ttl_seconds: int,
    limits: ArchiveLimits,
) -> tuple[EphemeralRepositorySnapshot, RepositoryIndex, bool]:
    existing = session.exec(select(WebCodeRepository).where(
        WebCodeRepository.owner_user_id == owner_user_id,
        WebCodeRepository.repository_id == repository_id,
        WebCodeRepository.status == "ready",
    )).first()
    if existing is not None:
        from .repository_store import get_repository_snapshot

        snapshot = get_repository_snapshot(
            store, owner_user_id=owner_user_id, repository_id=repository_id
        )
        if snapshot is not None:
            return snapshot, build_repository_index(snapshot.files), False

    validated = inspect_repository_zip(archive, limits=limits)
    index = build_repository_index(validated.files)
    digest = hashlib.sha256()
    for item in validated.files:
        digest.update(item.path.encode())
        digest.update(b"\0")
        digest.update(item.content_hash.encode())
    content_hash = digest.hexdigest()
    source_version = content_hash[:32]
    snapshot = EphemeralRepositorySnapshot(
        id=repository_id,
        owner_user_id=owner_user_id,
        source_version=source_version,
        content_hash=content_hash,
        created_at=utc_iso(),
        expires_at=expiration_iso(ttl_seconds),
        files=validated.files,
    )
    put_repository_snapshot(store, snapshot, ttl_seconds=ttl_seconds)
    expires_at = datetime.fromisoformat(snapshot.expires_at.replace("Z", "+00:00"))
    row = WebCodeRepository(
        id=str(uuid4()),
        owner_user_id=owner_user_id,
        repository_id=repository_id,
        idempotency_key=f"repository:{repository_id}:{source_version}",
        scope="temporary",
        source_version=source_version,
        content_hash=content_hash,
        status="ready",
        safe_metadata_json=json.dumps({
            "file_count": len(index.files),
            "symbol_count": len(index.symbols),
            "edge_count": len(index.edges),
            "ignored_file_count": validated.ignored_file_count,
            "languages": list(index.languages),
            "frameworks": list(index.frameworks),
            "dependency_versions": [
                {"name": name, "version": version}
                for name, version in index.dependency_versions
            ],
            "tool_versions": [
                {"name": name, "version": version}
                for name, version in index.tool_versions
            ],
            "validation_capabilities": [
                {
                    "check_id": item.check_id,
                    "category": item.category,
                    "executable": item.executable,
                }
                for item in index.validation_capabilities
            ],
        }, separators=(",", ":")),
        expires_at=expires_at,
    )
    session.add(row)
    session.flush()
    files_by_path: dict[str, WebCodeFile] = {}
    for item in index.files:
        file_row = WebCodeFile(
            repository_row_id=row.id,
            owner_user_id=owner_user_id,
            repository_id=repository_id,
            source_version=source_version,
            normalized_path=item.path,
            language=item.language,
            content_hash=item.content_hash,
            line_count=item.line_count,
            expires_at=expires_at,
        )
        session.add(file_row)
        session.flush()
        files_by_path[item.path] = file_row
    for symbol in index.symbols:
        file_row = files_by_path.get(symbol.path)
        if file_row is None:
            continue
        session.add(WebCodeSymbol(
            repository_row_id=row.id,
            file_id=file_row.id,
            owner_user_id=owner_user_id,
            repository_id=repository_id,
            normalized_path=symbol.path,
            symbol_name=symbol.name,
            symbol_kind=symbol.kind,
            signature=symbol.signature,
            start_line=symbol.start_line,
            end_line=symbol.end_line,
            content_hash=file_row.content_hash,
            expires_at=expires_at,
        ))
    for edge in index.edges:
        session.add(WebCodeEdge(
            repository_row_id=row.id,
            owner_user_id=owner_user_id,
            repository_id=repository_id,
            source_version=source_version,
            source_locator=edge.source,
            target_locator=edge.target,
            edge_kind=edge.kind,
            expires_at=expires_at,
        ))
    session.commit()
    return snapshot, index, True


def invalidate_repository_index(
    session: Session,
    *,
    owner_user_id: int,
    repository_id: str,
) -> None:
    now = datetime.now(timezone.utc)
    session.exec(update(WebCodeRepository).where(
        WebCodeRepository.owner_user_id == owner_user_id,
        WebCodeRepository.repository_id == repository_id,
    ).values(status="expired", updated_at=now))
    for model in (WebCodeFile, WebCodeSymbol, WebCodeEdge):
        session.exec(update(model).where(
            model.owner_user_id == owner_user_id,
            model.repository_id == repository_id,
        ).values(status="expired"))
