from __future__ import annotations

from dataclasses import replace

from .models import RetrievalCandidate


def select_by_marginal_value(
    candidates: tuple[RetrievalCandidate, ...],
    *,
    item_limit: int,
    token_cap: int,
) -> tuple[RetrievalCandidate, ...]:
    """Greedy deterministic selection by relevance value per token."""

    ordered = sorted(
        candidates,
        key=lambda item: (
            -(item.fused_score / max(1, item.token_count)),
            -item.fused_score,
            item.candidate_id,
        ),
    )
    selected: list[RetrievalCandidate] = []
    used = 0
    for item in ordered:
        if len(selected) >= item_limit:
            break
        if item.token_count > token_cap - used:
            continue
        selected.append(replace(item, rank=len(selected)))
        used += item.token_count
    return tuple(selected)
