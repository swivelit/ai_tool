from __future__ import annotations

import re

from .models import RetrievalCandidate


def _terms(text: str) -> set[str]:
    return set(re.findall(r"\w+", str(text or "").lower()))


def deduplicate_candidates(
    candidates: tuple[RetrievalCandidate, ...],
    *,
    overlap_threshold: float = 0.85,
) -> tuple[RetrievalCandidate, ...]:
    selected: list[RetrievalCandidate] = []
    hashes: set[str] = set()
    term_sets: list[set[str]] = []
    for candidate in sorted(
        candidates, key=lambda item: (-item.fused_score, item.candidate_id)
    ):
        if candidate.content_hash and candidate.content_hash in hashes:
            continue
        terms = _terms(candidate.runtime_text)
        if terms and any(
            len(terms & prior) / max(1, min(len(terms), len(prior)))
            >= overlap_threshold
            for prior in term_sets
        ):
            continue
        selected.append(candidate)
        term_sets.append(terms)
        if candidate.content_hash:
            hashes.add(candidate.content_hash)
    return tuple(selected)
