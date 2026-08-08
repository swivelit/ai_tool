from __future__ import annotations

import hashlib
import os

from ..ai.swico_tiers import free_enabled


def free_rollout_percent() -> int:
    try:
        value = int(os.getenv("SWICO_FREE_ROLLOUT_PERCENT", "0"))
    except (TypeError, ValueError):
        return 0
    return value if 0 <= value <= 100 else 0


def swico_free_eligible(user_id: int, *, internal_account: bool = False) -> bool:
    """Return the backend-only Free eligibility decision without exposing its bucket."""
    if not free_enabled():
        return False
    if internal_account:
        return True
    percent = free_rollout_percent()
    if percent <= 0:
        return False
    if percent >= 100:
        return True
    digest = hashlib.sha256(
        f"swico-free-rollout-v1:{int(user_id)}".encode("utf-8")
    ).digest()
    bucket = int.from_bytes(digest[:8], "big") % 100
    return bucket < percent
