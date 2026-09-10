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

    if any(
        dict(item.bounded_metadata).get("coverage_mode") == "representative"
        for item in candidates
    ):
        return _select_representative_overview(
            candidates, item_limit=item_limit, token_cap=token_cap,
        )

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


def _select_representative_overview(
    candidates: tuple[RetrievalCandidate, ...],
    *,
    item_limit: int,
    token_cap: int,
) -> tuple[RetrievalCandidate, ...]:
    """Keep bounded overview coverage fair after fusion and score reranking.

    Lexical retrieval has already chosen representative chunks in source order.
    RRF and marginal-value ordering must not turn that bounded operation into a
    relevance-only search that drops an entire uploaded file.
    """
    groups: dict[str, list[RetrievalCandidate]] = {}
    for item in candidates:
        metadata = dict(item.bounded_metadata)
        if metadata.get("coverage_mode") != "representative":
            continue
        upload_id = metadata.get("upload_id") or metadata.get("upload_name") or item.source_locator
        groups.setdefault(str(upload_id), []).append(item)
    for items in groups.values():
        items.sort(
            key=lambda item: (
                int(dict(item.bounded_metadata).get("chunk_index") or 0),
                item.source_locator,
                item.candidate_id,
            ),
        )
    ordered_groups = sorted(
        groups.values(),
        key=lambda items: (
            int(dict(items[0].bounded_metadata).get("upload_index") or 0),
            str(dict(items[0].bounded_metadata).get("upload_id") or ""),
        ),
    )
    selected: list[RetrievalCandidate] = []
    remaining = max(0, int(token_cap))
    item_budget = max(0, int(item_limit))

    # Reserve one affordable excerpt per source before adding depth. A first
    # excerpt can be too large even though a later representative excerpt
    # would let every uploaded file fit within the same tier budget.
    if len(ordered_groups) <= item_budget:
        coverage = [
            min(
                items,
                key=lambda item: (
                    item.token_count,
                    int(dict(item.bounded_metadata).get("chunk_index") or 0),
                    item.source_locator,
                    item.candidate_id,
                ),
            )
            for items in ordered_groups if items
        ]
        if len(coverage) == len(ordered_groups) and sum(item.token_count for item in coverage) <= remaining:
            reserved = {item.candidate_id for item in coverage}
            for item in coverage:
                selected.append(replace(item, rank=len(selected)))
                remaining -= item.token_count
            ordered_groups = [
                [item for item in items if item.candidate_id not in reserved]
                for items in ordered_groups
            ]
    while ordered_groups and len(selected) < max(0, int(item_limit)):
        next_groups: list[list[RetrievalCandidate]] = []
        for items in ordered_groups:
            while items and items[0].token_count > remaining:
                # The central pack cap cannot include this chunk without
                # exceeding the tier budget; preserve other files if possible.
                items.pop(0)
            if items and len(selected) < max(0, int(item_limit)):
                item = items.pop(0)
                selected.append(replace(item, rank=len(selected)))
                remaining -= item.token_count
            if items:
                next_groups.append(items)
        ordered_groups = next_groups
    return tuple(selected)
