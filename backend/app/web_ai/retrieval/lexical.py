from __future__ import annotations

from ...web_api.attachment_context import (
    is_document_overview_request, rank_attachment_chunks,
)
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
        overview_request = is_document_overview_request(query)
        ordered = sorted(
            ranked,
            key=lambda item: (-item.score, item.upload_index, item.chunk_index),
        )
        if overview_request:
            by_upload: dict[int, list] = {}
            for item in ordered:
                by_upload.setdefault(item.upload_index, []).append(item)
            representative = []
            for upload_index in sorted(by_upload):
                items = by_upload[upload_index]
                representative.extend(items[index] for index in sorted({0, len(items) // 2, len(items) - 1}))
            chosen = sorted(
                representative,
                key=lambda item: (item.upload_index, item.chunk_index),
            )[: max(0, int(limit))]
        else:
            positive = [item for item in ordered if item.score > 0]
            chosen = (positive or ordered[:1])[: max(0, int(limit))]
        return tuple(
            candidate_from_chunk(
                upload=owned[item.upload_index],
                chunk_index=item.chunk_index,
                lexical_score=(0.5 if overview_request else max(0.0, min(1.0, item.score))),
                query_coverage=(1.0 if overview_request else max(0.0, min(1.0, item.score))),
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
