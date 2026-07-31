from __future__ import annotations

from .models import EvidenceItem


def build_source_map(items: tuple[EvidenceItem, ...]) -> tuple[tuple[str, str], ...]:
    return tuple((item.citation_label, item.source_locator) for item in items)
