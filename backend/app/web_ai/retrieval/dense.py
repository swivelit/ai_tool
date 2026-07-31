from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
import re

from ...web_api.upload_store import (
    EphemeralUpload,
    EphemeralUploadStore,
    UploadStoreUnavailable,
)
from .attachment import candidate_from_chunk, upload_content_hash
from .models import RetrievalCandidate


EmbeddingFunction = Callable[[Sequence[str]], Sequence[Sequence[float]]]
VECTOR_SCHEMA_VERSION = "v1"
_KEY_SAFE = re.compile(r"[^a-zA-Z0-9._-]+")


class DenseRetrievalUnavailable(RuntimeError):
    pass


def _key_part(value: object, limit: int = 128) -> str:
    return _KEY_SAFE.sub("_", str(value or ""))[:limit]


def _remaining_ttl(upload: EphemeralUpload) -> int:
    try:
        expires = datetime.fromisoformat(upload.expires_at.replace("Z", "+00:00"))
    except ValueError:
        return 0
    return max(0, int((expires - datetime.now(timezone.utc)).total_seconds()))


def _vector_key(
    *,
    owner_user_id: int,
    upload_id: str,
    content_hash: str,
    chunk_index: int,
    model: str,
    schema_version: str,
) -> str:
    return (
        "swico:web-rag:vector:"
        f"{owner_user_id}:{_key_part(upload_id)}:{content_hash}:"
        f"{chunk_index}:{_key_part(model)}:{_key_part(schema_version)}"
    )


def _query_key(
    *,
    owner_user_id: int,
    upload_id: str,
    content_hash: str,
    query_hash: str,
    model: str,
    schema_version: str,
) -> str:
    return (
        "swico:web-rag:query:"
        f"{owner_user_id}:{_key_part(upload_id)}:{content_hash}:"
        f"{query_hash}:{_key_part(model)}:{_key_part(schema_version)}"
    )


def _decode_vector(raw: str | None, dimensions: int) -> tuple[float, ...] | None:
    if not raw:
        return None
    try:
        vector = tuple(float(value) for value in json.loads(raw))
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if len(vector) != dimensions or not all(math.isfinite(value) for value in vector):
        return None
    return vector


def _encode_vector(vector: Sequence[float], dimensions: int) -> str:
    normalized = tuple(float(value) for value in vector)
    if len(normalized) != dimensions or not all(
        math.isfinite(value) for value in normalized
    ):
        raise DenseRetrievalUnavailable("malformed_vector")
    return json.dumps(normalized, separators=(",", ":"))


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if not left_norm or not right_norm:
        return 0.0
    return max(-1.0, min(1.0, dot / (left_norm * right_norm)))


class TemporaryDenseRetriever:
    source_name = "documents"
    status_code = "dense"

    def __init__(
        self,
        *,
        store: EphemeralUploadStore,
        embed: EmbeddingFunction,
        model: str,
        dimensions: int,
        query_cache_ttl_seconds: int,
        schema_version: str = VECTOR_SCHEMA_VERSION,
    ) -> None:
        self.store = store
        self.embed = embed
        self.model = model
        self.dimensions = int(dimensions)
        self.query_cache_ttl_seconds = int(query_cache_ttl_seconds)
        self.schema_version = schema_version

    def retrieve(
        self,
        *,
        query: str,
        uploads: list[EphemeralUpload],
        owner_user_id: int,
        limit: int,
        cancellation_signal: object | None = None,
    ) -> tuple[RetrievalCandidate, ...]:
        if _cancelled(cancellation_signal):
            return ()
        candidates: list[RetrievalCandidate] = []
        for supplied in uploads:
            # Fetching again is intentional: ownership and expiry are verified
            # immediately before every dense retrieval.
            try:
                upload = self.store.get(supplied.id)
            except UploadStoreUnavailable as exc:
                raise DenseRetrievalUnavailable("dense_unavailable") from exc
            if upload is None:
                raise DenseRetrievalUnavailable("upload_expired")
            if upload.owner_user_id != int(owner_user_id):
                raise PermissionError("cross-user upload retrieval rejected")
            candidates.extend(
                self._retrieve_upload(
                    query=query,
                    upload=upload,
                    cancellation_signal=cancellation_signal,
                )
            )
        ordered = sorted(
            candidates,
            key=lambda item: (-item.semantic_score, item.candidate_id),
        )
        return tuple(
            RetrievalCandidate(
                **{
                    **item.__dict__,
                    "rank": rank,
                    "fused_score": item.semantic_score,
                    "score": item.semantic_score,
                }
            )
            for rank, item in enumerate(ordered[: max(0, int(limit))])
        )

    def _retrieve_upload(
        self,
        *,
        query: str,
        upload: EphemeralUpload,
        cancellation_signal: object | None,
    ) -> list[RetrievalCandidate]:
        ttl = _remaining_ttl(upload)
        if ttl <= 0:
            raise DenseRetrievalUnavailable("upload_expired")
        upload_hash = upload_content_hash(upload)
        vectors: list[tuple[float, ...] | None] = []
        missing_indexes: list[int] = []
        for index, _chunk in enumerate(upload.chunks):
            key = _vector_key(
                owner_user_id=upload.owner_user_id,
                upload_id=upload.id,
                content_hash=upload_hash,
                chunk_index=index,
                model=self.model,
                schema_version=self.schema_version,
            )
            try:
                vector = _decode_vector(
                    self.store.get_auxiliary(key), self.dimensions
                )
            except (AttributeError, UploadStoreUnavailable) as exc:
                raise DenseRetrievalUnavailable("dense_unavailable") from exc
            vectors.append(vector)
            if vector is None:
                missing_indexes.append(index)
        if missing_indexes:
            if _cancelled(cancellation_signal):
                return []
            embedded = self.embed(
                [upload.chunks[index].text for index in missing_indexes]
            )
            if len(embedded) != len(missing_indexes):
                raise DenseRetrievalUnavailable("malformed_vector")
            for index, vector in zip(missing_indexes, embedded):
                encoded = _encode_vector(vector, self.dimensions)
                decoded = _decode_vector(encoded, self.dimensions)
                vectors[index] = decoded
                key = _vector_key(
                    owner_user_id=upload.owner_user_id,
                    upload_id=upload.id,
                    content_hash=upload_hash,
                    chunk_index=index,
                    model=self.model,
                    schema_version=self.schema_version,
                )
                self.store.set_auxiliary(key, encoded, ttl)
        query_hash = sha256(query.encode("utf-8", errors="ignore")).hexdigest()
        query_key = _query_key(
            owner_user_id=upload.owner_user_id,
            upload_id=upload.id,
            content_hash=upload_hash,
            query_hash=query_hash,
            model=self.model,
            schema_version=self.schema_version,
        )
        query_vector = _decode_vector(
            self.store.get_auxiliary(query_key), self.dimensions
        )
        if query_vector is None:
            embedded_query = self.embed([query])
            if len(embedded_query) != 1:
                raise DenseRetrievalUnavailable("malformed_vector")
            encoded_query = _encode_vector(
                embedded_query[0], self.dimensions
            )
            query_vector = _decode_vector(encoded_query, self.dimensions)
            self.store.set_auxiliary(
                query_key,
                encoded_query,
                min(ttl, self.query_cache_ttl_seconds),
            )
        if query_vector is None:
            raise DenseRetrievalUnavailable("malformed_vector")
        results: list[RetrievalCandidate] = []
        for index, vector in enumerate(vectors):
            if vector is None:
                continue
            similarity = (_cosine(query_vector, vector) + 1.0) / 2.0
            results.append(
                candidate_from_chunk(
                    upload=upload,
                    chunk_index=index,
                    semantic_score=similarity,
                )
            )
        return results


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)
