from __future__ import annotations

from dataclasses import replace

from .models import RetrievalCandidate


def reciprocal_rank_fusion(
    result_sets: tuple[tuple[RetrievalCandidate, ...], ...],
    *,
    limit: int,
    rank_constant: int = 60,
) -> tuple[RetrievalCandidate, ...]:
    """Deterministically fuse unrelated score scales by rank."""

    by_hash: dict[str, RetrievalCandidate] = {}
    totals: dict[str, float] = {}
    for results in result_sets:
        ordered = sorted(
            results,
            key=lambda item: (-max(item.score, item.lexical_score, item.semantic_score), item.candidate_id),
        )
        for rank, item in enumerate(ordered, start=1):
            key = item.content_hash or item.candidate_id
            totals[key] = totals.get(key, 0.0) + 1.0 / (rank_constant + rank)
            existing = by_hash.get(key)
            if existing is None:
                by_hash[key] = item
            else:
                by_hash[key] = replace(
                    existing,
                    lexical_score=max(existing.lexical_score, item.lexical_score),
                    semantic_score=max(existing.semantic_score, item.semantic_score),
                    metadata_score=max(existing.metadata_score, item.metadata_score),
                )
    ordered_keys = sorted(totals, key=lambda key: (-totals[key], key))
    return tuple(
        replace(
            by_hash[key],
            # RRF determines order; the strongest absolute retrieval signal
            # remains the confidence. A one-item result therefore cannot
            # become 1.0 merely because it ranked first.
            fused_score=max(
                by_hash[key].lexical_score,
                by_hash[key].semantic_score,
                by_hash[key].metadata_score,
                min(1.0, totals[key]),
            ),
            score=max(
                by_hash[key].lexical_score,
                by_hash[key].semantic_score,
                by_hash[key].metadata_score,
                min(1.0, totals[key]),
            ),
            rank=rank,
        )
        for rank, key in enumerate(ordered_keys[: max(0, int(limit))])
    )
