from __future__ import annotations

import json
import logging
import math
import os
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlmodel import Session
from sqlmodel import select

from .models import RagEmbedding
from .time_utils import utc_now

logger = logging.getLogger(__name__)


class VectorStore:
    def __init__(self, engine: Any, *, backend: str = "auto") -> None:
        self.engine = engine
        self.backend = str(backend or "auto").strip().lower() or "auto"
        self.embedding_dimensions = int(os.getenv("VECTOR_STORE_EMBEDDING_DIMS", "1536") or 1536)
        self.ivfflat_lists = int(os.getenv("VECTOR_STORE_IVFFLAT_LISTS", "100") or 100)
        self._resolved_backend = "relational_fallback"

    def initialize(self) -> None:
        engine_name = str(getattr(getattr(self.engine, "dialect", None), "name", "") or "").lower()
        wants_pgvector = self.backend == "pgvector" or (self.backend == "auto" and engine_name.startswith("postgres"))

        if wants_pgvector:
            try:
                with self.engine.begin() as conn:
                    conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
                    conn.execute(
                        text(
                            f"""
                            CREATE TABLE IF NOT EXISTS vector_store_entries (
                                id BIGSERIAL PRIMARY KEY,
                                user_id BIGINT NULL,
                                source_type TEXT NOT NULL,
                                source_id TEXT NOT NULL,
                                content_hash TEXT NOT NULL UNIQUE,
                                content_text TEXT NOT NULL,
                                embedding_json JSONB NOT NULL,
                                embedding vector({self.embedding_dimensions}) NOT NULL,
                                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                            )
                            """
                        )
                    )
                    conn.execute(
                        text(
                            "CREATE INDEX IF NOT EXISTS ix_vector_store_entries_user_source "
                            "ON vector_store_entries (user_id, source_type, updated_at DESC)"
                        )
                    )
                    try:
                        conn.execute(
                            text(
                                f"CREATE INDEX IF NOT EXISTS ix_vector_store_entries_embedding_cosine "
                                f"ON vector_store_entries USING ivfflat (embedding vector_cosine_ops) "
                                f"WITH (lists = {max(1, self.ivfflat_lists)})"
                            )
                        )
                    except Exception:
                        logger.exception("pgvector ivfflat index creation failed")
                self._resolved_backend = "pgvector"
                logger.info(
                    "vector store initialized",
                    extra={"vector_backend": self._resolved_backend},
                )
                return
            except Exception:
                logger.exception("pgvector init failed, falling back to relational embeddings")

        self._resolved_backend = "relational_fallback"
        logger.info(
            "vector store initialized",
            extra={"vector_backend": self._resolved_backend},
        )

    @property
    def mode(self) -> str:
        return self._resolved_backend

    def status(self) -> Dict[str, Any]:
        return {
            "mode": self._resolved_backend,
            "backend": self.backend,
            "embedding_dimensions": self.embedding_dimensions,
            "is_real_vector_backend": self._resolved_backend == "pgvector",
        }

    def upsert(
        self,
        session: Session,
        *,
        user_id: Optional[int],
        source_type: str,
        source_id: str,
        content_hash: str,
        content_text: str,
        embedding: List[float],
        updated_at: Optional[datetime] = None,
    ) -> None:
        if not embedding:
            return

        updated_at = updated_at or utc_now()
        if self._resolved_backend != "pgvector":
            row = session.exec(
                select(RagEmbedding).where(RagEmbedding.content_hash == content_hash)
            ).first()
            payload = json.dumps([float(v) for v in embedding], ensure_ascii=False)
            norm = math.sqrt(sum(float(v) * float(v) for v in embedding))
            if row is None:
                row = RagEmbedding(
                    user_id=user_id,
                    source_type=source_type,
                    source_id=source_id,
                    content_hash=content_hash,
                    content_text=content_text,
                    embedding_json=payload,
                    embedding_norm=norm,
                    updated_at=updated_at,
                )
            else:
                row.user_id = user_id
                row.source_type = source_type
                row.source_id = source_id
                row.content_text = content_text
                row.embedding_json = payload
                row.embedding_norm = norm
                row.updated_at = updated_at
            session.add(row)
            session.commit()
            return

        vector_literal = "[" + ",".join(f"{float(v):.8f}" for v in embedding) + "]"
        session.exec(
            text(
                """
                INSERT INTO vector_store_entries
                    (user_id, source_type, source_id, content_hash, content_text, embedding_json, embedding, updated_at)
                VALUES
                    (:user_id, :source_type, :source_id, :content_hash, :content_text, CAST(:embedding_json AS JSONB), :embedding::vector, :updated_at)
                ON CONFLICT (content_hash)
                DO UPDATE SET
                    content_text = EXCLUDED.content_text,
                    embedding_json = EXCLUDED.embedding_json,
                    embedding = EXCLUDED.embedding,
                    updated_at = EXCLUDED.updated_at
                """
            ),
            {
                "user_id": user_id,
                "source_type": source_type,
                "source_id": source_id,
                "content_hash": content_hash,
                "content_text": content_text,
                "embedding_json": json.dumps([float(v) for v in embedding], ensure_ascii=False),
                "embedding": vector_literal,
                "updated_at": updated_at,
            },
        )
        session.commit()

    def search(
        self,
        session: Session,
        *,
        user_id: Optional[int],
        query_embedding: List[float],
        limit: int = 8,
        source_types: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        if not query_embedding:
            return []

        if self._resolved_backend != "pgvector":
            statement = select(RagEmbedding)
            if user_id is not None:
                statement = statement.where(RagEmbedding.user_id == user_id)
            if source_types:
                statement = statement.where(RagEmbedding.source_type.in_(source_types))
            rows = list(
                session.exec(statement.order_by(RagEmbedding.updated_at.desc()).limit(500)).all()
            )
            query_norm = math.sqrt(sum(float(v) * float(v) for v in query_embedding))
            results: List[Dict[str, Any]] = []
            for row in rows:
                try:
                    stored = [float(v) for v in json.loads(row.embedding_json or "[]")]
                except (TypeError, ValueError):
                    continue
                norm = float(row.embedding_norm or 0.0) or math.sqrt(
                    sum(value * value for value in stored)
                )
                if not stored or query_norm <= 0.0 or norm <= 0.0:
                    continue
                dot = sum(
                    float(query_embedding[index]) * stored[index]
                    for index in range(min(len(query_embedding), len(stored)))
                )
                results.append(
                    {
                        "source_type": row.source_type,
                        "source_id": row.source_id,
                        "content_text": row.content_text,
                        "updated_at": row.updated_at,
                        "score_semantic": max(0.0, min(1.0, dot / (query_norm * norm))),
                    }
                )
            return sorted(
                results, key=lambda item: float(item["score_semantic"]), reverse=True
            )[: max(1, int(limit))]

        vector_literal = "[" + ",".join(f"{float(v):.8f}" for v in query_embedding) + "]"
        source_filter_sql = ""
        params: Dict[str, Any] = {
            "user_id": user_id,
            "embedding": vector_literal,
            "limit": max(1, int(limit)),
        }
        if source_types:
            source_filter_sql = " AND source_type = ANY(:source_types)"
            params["source_types"] = list(source_types)

        rows = session.exec(
            text(
                f"""
                SELECT source_type, source_id, content_text, updated_at,
                       1 - (embedding <=> :embedding::vector) AS score_semantic
                FROM vector_store_entries
                WHERE (:user_id IS NULL OR user_id = :user_id)
                {source_filter_sql}
                ORDER BY embedding <=> :embedding::vector
                LIMIT :limit
                """
            ),
            params,
        ).all()

        results: List[Dict[str, Any]] = []
        for row in rows:
            mapping = getattr(row, "_mapping", row)
            results.append(
                {
                    "source_type": str(mapping["source_type"]),
                    "source_id": str(mapping["source_id"]),
                    "content_text": str(mapping["content_text"]),
                    "updated_at": mapping["updated_at"],
                    "score_semantic": float(mapping["score_semantic"] or 0.0),
                }
            )
        return results


_DEFAULT_STORE: Optional[VectorStore] = None
_DEFAULT_STORE_LOCK = threading.Lock()


def get_vector_store() -> VectorStore:
    """Return the process-wide store used by cache and memory write paths."""
    global _DEFAULT_STORE
    if _DEFAULT_STORE is not None:
        return _DEFAULT_STORE
    with _DEFAULT_STORE_LOCK:
        if _DEFAULT_STORE is None:
            from .database import engine

            _DEFAULT_STORE = VectorStore(
                engine, backend=os.getenv("VECTOR_STORE_BACKEND", "auto")
            )
            _DEFAULT_STORE.initialize()
    return _DEFAULT_STORE
