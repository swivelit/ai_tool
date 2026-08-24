"""Provider-neutral TRIAG planner contracts used by the website path.

These adapters intentionally call the existing deterministic optimizer and
retrieval runtime rather than introducing a second retrieval or safety stack.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..ai.intent import classify_intent_with_metadata
from .retrieval.corrective import CorrectiveRetrievalController
from .settings import TriagSettings
from .tier_policy import TierPolicy
from ..web_api.turn_optimizer import optimize_web_turn


RequestKind = Literal["deterministic", "cache", "provider", "blocked"]
EvidenceConfidence = Literal[
    "sufficient", "partially_sufficient", "ambiguous", "contradictory", "insufficient"
]


@dataclass(frozen=True)
class RequestPlan:
    intent: str
    answer_class: str
    route: RequestKind
    query_variants: tuple[str, ...]
    reason: str


class RequestTriagPlanner:
    def from_existing(
        self,
        message: str,
        *,
        decision: object,
        optimization: object,
    ) -> RequestPlan:
        """Adapt the existing optimizer result into the planner contract.

        The website already computes these decisions with attachment and
        continuity context.  Keeping this adapter avoids a second optimizer
        with subtly different routing semantics.
        """

        route: RequestKind = (
            "blocked" if optimization.optimization_route == "safety_block"
            else "deterministic" if optimization.local_intent
            else "cache" if optimization.cache_eligible
            else "provider"
        )
        return RequestPlan(
            intent=decision.intent,
            answer_class=optimization.answer_class,
            route=route,
            query_variants=(message[:2_000],),
            reason=optimization.optimization_route or decision.reason,
        )

    def plan(
        self,
        message: str,
        *,
        reply_language: str | None = None,
        previous_topic: str | None = None,
    ) -> RequestPlan:
        decision = classify_intent_with_metadata(message)
        optimization = optimize_web_turn(
            message,
            reply_language=reply_language,
            previous_topic=previous_topic,
        )
        return self.from_existing(
            message,
            decision=decision,
            optimization=optimization,
        )


@dataclass(frozen=True)
class EvidencePlan:
    confidence: EvidenceConfidence
    query_variants: tuple[str, ...]
    dense_allowed: bool
    corrective_round_limit: int


class RetrievalTriagPlanner:
    def plan(
        self,
        request_plan: RequestPlan,
        *,
        policy: TierPolicy,
        settings: TriagSettings,
    ) -> EvidencePlan:
        controller = CorrectiveRetrievalController(
            policy=policy,
            configured_max_rounds=settings.max_corrective_rounds,
        )
        return EvidencePlan(
            confidence="insufficient" if request_plan.route == "provider" else "sufficient",
            query_variants=request_plan.query_variants[: policy.query_variant_limit],
            dense_allowed=(
                settings.dense_runtime_enabled and policy.dense_retrieval_allowed
            ),
            corrective_round_limit=controller.maximum_rounds,
        )
