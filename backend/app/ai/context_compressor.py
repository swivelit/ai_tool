
from __future__ import annotations

import os
import re
import logging
from typing import Any, Dict, List, Optional, Union

logger = logging.getLogger(__name__)


class ContextCompressor:
    """Compresses context data to reduce token consumption.

    Strategies applied:
    - Truncation: keeps only the most relevant chunks
    - Whitespace normalization: removes redundant spaces/newlines
    - Length capping: limits individual chunk length
    - Deduplication: removes duplicate content
    """

    DEFAULT_MAX_CHUNKS = int(os.getenv("CONTEXT_COMPRESSOR_MAX_CHUNKS", "2"))
    DEFAULT_MAX_CHUNK_CHARS = int(os.getenv("CONTEXT_COMPRESSOR_MAX_CHUNK_CHARS", "400"))
    DEFAULT_MAX_TOTAL_CHARS = int(os.getenv("CONTEXT_COMPRESSOR_MAX_TOTAL_CHARS", "1000"))

    def __init__(
        self,
        *,
        max_chunks: int = DEFAULT_MAX_CHUNKS,
        max_chunk_chars: int = DEFAULT_MAX_CHUNK_CHARS,
        max_total_chars: int = DEFAULT_MAX_TOTAL_CHARS,
    ) -> None:
        self.max_chunks = max_chunks
        self.max_chunk_chars = max_chunk_chars
        self.max_total_chars = max_total_chars

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def compress(self, chunks: Any) -> list:
        """Compress a list of chunks (strings or dicts) for provider context.

        Accepts:
        - A list of strings
        - A list of dicts with a ``content`` or ``text`` key
        - A single string (wrapped into a one-element list)
        - None / empty → returns []
        """
        if not chunks:
            return []

        # Normalize to list
        if isinstance(chunks, str):
            chunks = [chunks]

        if not isinstance(chunks, (list, tuple)):
            return []

        # Deduplicate while preserving order
        seen: set[str] = set()
        unique: list = []
        for chunk in chunks:
            key = self._text_of(chunk).strip().lower()
            if key and key not in seen:
                seen.add(key)
                unique.append(chunk)

        # Keep only the top-N most relevant chunks
        selected = unique[: self.max_chunks]

        # Compress each chunk
        compressed: list = []
        total_chars = 0
        for chunk in selected:
            result = self._compress_chunk(chunk)
            result_text = self._text_of(result)
            if not result_text:
                continue

            # Enforce total character budget
            if total_chars + len(result_text) > self.max_total_chars:
                remaining = self.max_total_chars - total_chars
                if remaining <= 50:
                    break
                result = self._truncate(result, remaining)

            compressed.append(result)
            total_chars += len(self._text_of(result))

        logger.debug(
            "ContextCompressor: %d → %d chunks, %d chars",
            len(chunks),
            len(compressed),
            total_chars,
        )
        return compressed

    def compress_text(self, text: str, *, max_chars: Optional[int] = None) -> str:
        """Compress a single text string."""
        if not text:
            return ""
        cap = max_chars or self.max_chunk_chars
        return self._normalize_whitespace(text)[:cap]

    def compress_history(
        self, history: List[Dict[str, str]], *, max_turns: int = 3, max_chars_per_turn: int = 400
    ) -> List[Dict[str, str]]:
        """Compress conversation history to the most recent *max_turns*.

        Each turn's content is capped at *max_chars_per_turn* characters.
        """
        if not history:
            return []

        recent = history[-max_turns:]
        compressed: list[dict[str, str]] = []
        for turn in recent:
            entry = dict(turn)
            content = str(entry.get("content", ""))
            if len(content) > max_chars_per_turn:
                entry["content"] = content[:max_chars_per_turn] + "..."
            compressed.append(entry)
        return compressed

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _compress_chunk(self, chunk: Any) -> Any:
        """Compress a single chunk (string or dict)."""
        if isinstance(chunk, str):
            return self._normalize_whitespace(chunk)[: self.max_chunk_chars]

        if isinstance(chunk, dict):
            result = dict(chunk)
            for key in ("content", "text"):
                if key in result and isinstance(result[key], str):
                    result[key] = self._normalize_whitespace(result[key])[: self.max_chunk_chars]
            return result

        # Unknown type — return as-is
        return chunk

    def _truncate(self, chunk: Any, max_chars: int) -> Any:
        """Hard-truncate a chunk to *max_chars*."""
        if isinstance(chunk, str):
            return chunk[:max_chars]

        if isinstance(chunk, dict):
            result = dict(chunk)
            for key in ("content", "text"):
                if key in result and isinstance(result[key], str):
                    result[key] = result[key][:max_chars]
            return result

        return chunk

    @staticmethod
    def _text_of(chunk: Any) -> str:
        """Extract the text content of a chunk for measurement."""
        if isinstance(chunk, str):
            return chunk
        if isinstance(chunk, dict):
            return str(chunk.get("content") or chunk.get("text") or "")
        return str(chunk)

    @staticmethod
    def _normalize_whitespace(text: str) -> str:
        """Collapse redundant whitespace and blank lines."""
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()
