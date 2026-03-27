from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlmodel import Session

logger = logging.getLogger(__name__)


class VectorStore:
    def __init__(self, engine: Any, *, backend: str = "auto") -> None:
        self.engine = engine
        self.backend = backend
        self._resolved_backend = "sqljson"

    def initialize(self) -> None:
        engine_name = getattr(getattr(self.engine, "dialect", None), "name", "")
        if self.backend == "pgvector" or (self.backend == "auto" and engine_name.startswith("postgres")):
            try:
                with self.engine.begin() as conn:
                    conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
                    conn.execute(
                        text(
                            """
                            CREATE TABLE IF NOT EXISTS vector_store_entries (
                                id BIGSERIAL PRIMARY KEY,
                                user_id BIGINT NULL,
                                source_type TEXT NOT NULL,
                                source_id TEXT NOT NULL,
                                content_hash TEXT NOT NULL UNIQUE,
                                content_text TEXT NOT NULL,
                                embedding_json JSONB NOT NULL,
                                embedding vector(1536) NOT NULL,
                                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                            )
                            """
                        )
                    )
                    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_vector_store_entries_user_source ON vector_store_entries (user_id, source_type, updated_at DESC)"))
                self._resolved_backend = "pgvector"
                logger.info("vector store initialized", extra={"job_type": "vector_store", "route": "pgvector"})
                return
            except Exception:
                logger.exception("pgvector init failed, falling back to sqljson")
        self._resolved_backend = "sqljson"

    @property
    def mode(self) -> str:
        return self._resolved_backend

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
        if self._resolved_backend != "pgvector":
            return
        if not embedding:
            return
        updated_at = updated_at or datetime.utcnow()
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
        if self._resolved_backend != "pgvector" or not query_embedding:
            return []
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