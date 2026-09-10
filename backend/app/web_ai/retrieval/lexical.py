from __future__ import annotations

from dataclasses import replace

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
            queues: dict[int, list] = {}
            for upload_index in sorted(by_upload):
                items = sorted(by_upload[upload_index], key=lambda item: item.chunk_index)
                queues[upload_index] = [
                    items[index] for index in sorted({0, len(items) // 2, len(items) - 1})
                ]
            chosen = []
            while queues and len(chosen) < max(0, int(limit)):
                for upload_index in list(sorted(queues)):
                    if len(chosen) >= max(0, int(limit)):
                        break
                    if queues[upload_index]:
                        chosen.append(queues[upload_index].pop(0))
                    if not queues[upload_index]:
                        queues.pop(upload_index, None)
        else:
            positive = [item for item in ordered if item.score > 0]
            chosen = (positive or ordered[:1])[: max(0, int(limit))]
        output: list[RetrievalCandidate] = []
        for rank, item in enumerate(chosen):
            if _cancelled(cancellation_signal):
                break
            candidate = candidate_from_chunk(
                upload=owned[item.upload_index],
                chunk_index=item.chunk_index,
                lexical_score=max(0.0, min(1.0, item.score)),
                query_coverage=(
                    max(0.0, min(1.0, item.score))
                    if not overview_request else None
                ),
                rank=rank,
            )
            if overview_request:
                candidate = replace(
                    candidate,
                    bounded_metadata=(
                        *candidate.bounded_metadata,
                        ("coverage_mode", "representative"),
                        ("coverage_complete", "false"),
                    ),
                )
            output.append(candidate)
        return tuple(output)


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)
