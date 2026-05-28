from __future__ import annotations

from typing import Any


def normalize_age_group(value: Any) -> str:
    """Normalize supported age group aliases to the canonical profile values."""
    text = str(value or "").strip().lower()
    if not text:
        return ""
    normalized = (
        text.replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace(" ", "_")
    )
    aliases = {
        "under_13": "under_13",
        "under-13": "under_13",
        "13_17": "13_17",
        "13-17": "13_17",
        "18_25": "18_25",
        "18-25": "18_25",
        "26_35": "26_35",
        "26-35": "26_35",
        "36_45": "36_45",
        "36-45": "36_45",
        "46_60": "46_60",
        "46-60": "46_60",
        "60_plus": "60_plus",
        "60+": "60_plus",
        "60-plus": "60_plus",
        "prefer_not_to_say": "prefer_not_to_say",
        "prefer-not-to-say": "prefer_not_to_say",
    }
    return aliases.get(normalized, "")
