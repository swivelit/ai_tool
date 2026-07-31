from __future__ import annotations

from hashlib import sha256

from ...web_api.upload_store import EphemeralUpload
from .models import RetrievalCandidate


def token_count(text: str) -> int:
    return max(1, (len(str(text or "")) + 3) // 4)


def upload_content_hash(upload: EphemeralUpload) -> str:
    digest = sha256()
    for chunk in upload.chunks:
        digest.update(chunk.source.encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(chunk.text.encode("utf-8", errors="ignore"))
        digest.update(b"\0")
    return digest.hexdigest()


def chunk_content_hash(upload_hash: str, chunk_index: int, text: str) -> str:
    digest = sha256()
    digest.update(upload_hash.encode("ascii"))
    digest.update(f":{chunk_index}:".encode("ascii"))
    digest.update(text.encode("utf-8", errors="ignore"))
    return digest.hexdigest()


def safe_locator(upload: EphemeralUpload, chunk_index: int) -> str:
    source = (
        upload.chunks[chunk_index].source
        if 0 <= chunk_index < len(upload.chunks)
        else f"chunk {chunk_index + 1}"
    )
    return f"{upload.name} — {source}"[:256]


def candidate_from_chunk(
    *,
    upload: EphemeralUpload,
    chunk_index: int,
    lexical_score: float = 0.0,
    semantic_score: float = 0.0,
    rank: int = 0,
) -> RetrievalCandidate:
    upload_hash = upload_content_hash(upload)
    chunk = upload.chunks[chunk_index]
    content_hash = chunk_content_hash(upload_hash, chunk_index, chunk.text)
    score = max(lexical_score, semantic_score)
    return RetrievalCandidate(
        candidate_id=f"{upload.id}:{chunk_index}:{content_hash[:16]}",
        owner_user_id=upload.owner_user_id,
        source_kind="temporary_upload",
        source_locator=safe_locator(upload, chunk_index),
        runtime_text=chunk.text,
        token_count=token_count(chunk.text),
        lexical_score=max(0.0, min(1.0, lexical_score)),
        semantic_score=max(0.0, min(1.0, semantic_score)),
        fused_score=max(0.0, min(1.0, score)),
        content_hash=content_hash,
        bounded_metadata=(
            ("upload_id", upload.id),
            ("upload_name", upload.name[:128]),
            ("chunk_index", str(chunk_index)),
        ),
        rank=max(0, int(rank)),
    )
