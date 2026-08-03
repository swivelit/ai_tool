from __future__ import annotations

import re


SENTENCE_VALIDATOR_VERSION = "2026-08-03.1"
_ABBREVIATION = re.compile(
    r"\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.", re.IGNORECASE
)
_BOUNDARY = re.compile(r"[.!?।॥]+(?:\s+|$)|\n+")


def count_sentences(value: str) -> int:
    text = str(value or "").strip()
    if not text:
        return 0
    protected = _ABBREVIATION.sub(
        lambda match: match.group(0).replace(".", "\u2024"), text
    )
    return sum(1 for part in _BOUNDARY.split(protected) if part.strip())
