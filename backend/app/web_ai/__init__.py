"""TRIAG-RAG planning, retrieval, verification, and rollout components.

The package extends the existing website flow; it does not replace
``app.web_api.request_coordinator`` or ``app.ai.router``.
"""

from .execution_plan import ExecutionPlan
from .settings import TriagSettings
from .tier_policy import TierPolicy, tier_policy_for
from .token_allocator import DynamicTokenAllocator, TokenAllocation

__all__ = [
    "DynamicTokenAllocator",
    "ExecutionPlan",
    "TierPolicy",
    "TokenAllocation",
    "TriagSettings",
    "tier_policy_for",
]
