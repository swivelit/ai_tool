from __future__ import annotations

import re

from ..evidence.models import RetrievalStatus
from ..settings import TriagConfigurationError, TriagSettings
from .models import RetrievalCandidate


_NEGATION = re.compile(r"\b(no|not|never|without|cannot|can't|doesn't|isn't)\b", re.I)
_SEMANTIC_SUFFICIENCY_THRESHOLD = 0.55
_KNOWLEDGE_METADATA_SCORE = 0.5


def _score_thresholds() -> tuple[float, float]:
    try:
        settings = TriagSettings.from_environ()
    except TriagConfigurationError:
        return _SEMANTIC_SUFFICIENCY_THRESHOLD, _KNOWLEDGE_METADATA_SCORE
    return (
        settings.semantic_sufficiency_threshold,
        settings.knowledge_metadata_score,
    )


def evaluate_retrieval(
    candidates: tuple[RetrievalCandidate, ...],
) -> tuple[RetrievalStatus, tuple[str, ...]]:
    semantic_threshold, knowledge_metadata_score = _score_thresholds()
    support_scores = [
        max(item.lexical_score, item.semantic_score, item.metadata_score)
        for item in candidates
    ]
    query_coverage = [
        (
            item.query_coverage
            if item.query_coverage is not None else item.lexical_score
        )
        for item in candidates
    ]
    if not candidates or max(support_scores, default=0) < 0.08:
        return "insufficient", ()
    contradiction_keys: dict[str, set[bool]] = {}
    for item in candidates:
        normalized = " ".join(item.runtime_text.lower().split())
        key_tokens = [
            token
            for token in re.findall(r"\w+", normalized)
            if token not in {
                "no",
                "not",
                "never",
                "without",
                "cannot",
                "does",
                "do",
                "did",
                "doesn",
                "isn",
                "t",
            }
        ]
        key = " ".join(
            token[:-1] if len(token) > 4 and token.endswith("s") else token
            for token in key_tokens
        )[:160]
        if key:
            contradiction_keys.setdefault(key, set()).add(bool(_NEGATION.search(normalized)))
    contradictory = sorted(
        key for key, values in contradiction_keys.items() if len(values) > 1
    )
    if contradictory:
        return "contradictory", tuple(
            f"conflict_{index + 1}" for index, _ in enumerate(contradictory[:16])
        )
    high = [
        score
        for item, score, coverage in zip(
            candidates, support_scores, query_coverage, strict=True,
        )
        if (
            item.semantic_score >= semantic_threshold
            or item.metadata_score >= knowledge_metadata_score
            or (item.lexical_score >= 0.45 and coverage >= 0.45)
        )
    ]
    if high:
        return "sufficient", ()
    if len(candidates) >= 2:
        return "ambiguous", ()
    return "insufficient", ()
