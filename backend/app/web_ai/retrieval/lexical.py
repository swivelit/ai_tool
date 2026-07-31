from __future__ import annotations

from ...web_api.attachment_context import rank_attachment_chunks
from ...web_api.upload_store import EphemeralUpload
from .attachment import candidate_from_chunk
from .models import RetrievalCandidate


class LexicalAttachmentRetriever:
    source_name = "documents"
    status_code = "lexical"

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
        owned = [
            upload for upload in uploads
            if upload.owner_user_id == int(owner_user_id)
        ]
        ranked = rank_attachment_chunks(owned, query)
        ordered = sorted(
            ranked,
            key=lambda item: (-item.score, item.upload_index, item.chunk_index),
        )
        positive = [item for item in ordered if item.score > 0]
        chosen = (positive or ordered[:1])[: max(0, int(limit))]
        maximum = max((item.score for item in chosen), default=1.0) or 1.0
        return tuple(
            candidate_from_chunk(
                upload=owned[item.upload_index],
                chunk_index=item.chunk_index,
                lexical_score=item.score / maximum,
                rank=rank,
            )
            for rank, item in enumerate(chosen)
            if not _cancelled(cancellation_signal)
        )


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)
