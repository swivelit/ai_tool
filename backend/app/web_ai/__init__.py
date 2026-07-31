"""Phase 0/1 foundations for the future website TRIAG-RAG runtime.

This package is deliberately provider-free.  The production website continues
to use ``app.web_api.request_coordinator`` and ``app.ai.router``.
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
