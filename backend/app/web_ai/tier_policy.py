from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import os
from typing import Literal, cast


TierId = Literal["lite", "standard", "pro"]


@dataclass(frozen=True)
class TierPolicy:
    """Central, validated capability and token ceilings for web AI."""

    tier_id: TierId
    max_prompt_tokens: int
    max_output_tokens: int
    max_history_tokens: int
    max_memory_tokens: int
    max_profile_tokens: int
    max_document_tokens: int
    candidate_limit: int
    evidence_item_limit: int
    evidence_token_cap: int
    query_variant_limit: int
    retrieval_round_limit: int
    dense_retrieval_allowed: bool
    corrective_retrieval_allowed: bool
    claim_verifier_allowed: bool
    repository_retrieval_allowed: bool
    repository_validation_allowed: bool
    repository_contract_token_cap: int
    repository_required_validation_categories: tuple[str, ...]
    persistent_knowledge_allowed: bool
    triplet_retrieval_allowed: bool
    hierarchical_retrieval_allowed: bool
    knowledge_token_cap: int
    hierarchy_summary_token_cap: int
    max_provider_calls: int = 4

    def __post_init__(self) -> None:
        numeric = (
            self.max_prompt_tokens,
            self.max_output_tokens,
            self.max_history_tokens,
            self.max_memory_tokens,
            self.max_profile_tokens,
            self.max_document_tokens,
            self.candidate_limit,
            self.evidence_item_limit,
            self.evidence_token_cap,
            self.query_variant_limit,
            self.retrieval_round_limit,
            self.max_provider_calls,
            self.repository_contract_token_cap,
            self.knowledge_token_cap,
            self.hierarchy_summary_token_cap,
        )
        if any(value < 0 for value in numeric):
            raise ValueError("tier-policy ceilings must be non-negative")
        if self.max_prompt_tokens < 256 or self.max_prompt_tokens > 128_000:
            raise ValueError("max_prompt_tokens is outside the supported bounds")
        if self.max_output_tokens > self.max_prompt_tokens:
            raise ValueError("max_output_tokens cannot exceed max_prompt_tokens")
        if self.max_provider_calls > 4:
            raise ValueError("max_provider_calls exceeds the safety bound")
        if self.query_variant_limit > 8 or self.retrieval_round_limit > 2:
            raise ValueError("retrieval limits exceed supported bounds")
        if self.candidate_limit > 200 or self.evidence_item_limit > 32:
            raise ValueError("retrieval result limits exceed supported bounds")
        if self.evidence_token_cap > self.max_prompt_tokens:
            raise ValueError("evidence ceiling cannot exceed max_prompt_tokens")
        if self.repository_contract_token_cap > self.max_prompt_tokens:
            raise ValueError(
                "repository contract ceiling cannot exceed max_prompt_tokens"
            )
        if self.knowledge_token_cap > self.evidence_token_cap:
            raise ValueError(
                "knowledge ceiling cannot exceed the evidence ceiling"
            )
        if self.hierarchy_summary_token_cap > self.knowledge_token_cap:
            raise ValueError(
                "hierarchy ceiling cannot exceed the knowledge ceiling"
            )
        for source_limit in (
            self.max_history_tokens,
            self.max_memory_tokens,
            self.max_profile_tokens,
            self.max_document_tokens,
        ):
            if source_limit > self.max_prompt_tokens:
                raise ValueError("source ceiling cannot exceed max_prompt_tokens")

    @property
    def max_retrieval_candidates(self) -> int:
        """Phase 1 compatibility alias."""
        return self.candidate_limit

    @property
    def max_evidence_items(self) -> int:
        """Phase 1 compatibility alias."""
        return self.evidence_item_limit


_BASE_POLICY: dict[TierId, dict[str, object]] = {
    "lite": {
        "max_prompt_tokens": 3_000,
        "max_output_tokens": 1_600,
        "max_history_tokens": 1_200,
        "max_memory_tokens": 450,
        "max_profile_tokens": 300,
        "max_document_tokens": 1_200,
        "candidate_limit": 12,
        "evidence_item_limit": 4,
        "evidence_token_cap": 1_200,
        "query_variant_limit": 1,
        "retrieval_round_limit": 1,
        "dense_retrieval_allowed": False,
        "corrective_retrieval_allowed": False,
        "claim_verifier_allowed": False,
        "repository_retrieval_allowed": True,
        "repository_validation_allowed": False,
        "repository_contract_token_cap": 900,
        "repository_required_validation_categories": (),
        "persistent_knowledge_allowed": False,
        "triplet_retrieval_allowed": False,
        "hierarchical_retrieval_allowed": False,
        "knowledge_token_cap": 0,
        "hierarchy_summary_token_cap": 0,
    },
    "standard": {
        "max_prompt_tokens": 6_500,
        "max_output_tokens": 2_400,
        "max_history_tokens": 2_600,
        "max_memory_tokens": 975,
        "max_profile_tokens": 650,
        "max_document_tokens": 3_200,
        "candidate_limit": 30,
        "evidence_item_limit": 7,
        "evidence_token_cap": 3_200,
        "query_variant_limit": 2,
        "retrieval_round_limit": 2,
        "dense_retrieval_allowed": True,
        "corrective_retrieval_allowed": True,
        "claim_verifier_allowed": True,
        "repository_retrieval_allowed": True,
        "repository_validation_allowed": False,
        "repository_contract_token_cap": 1_800,
        "repository_required_validation_categories": (),
        "persistent_knowledge_allowed": True,
        "triplet_retrieval_allowed": False,
        "hierarchical_retrieval_allowed": True,
        "knowledge_token_cap": 2_400,
        "hierarchy_summary_token_cap": 512,
    },
    "pro": {
        "max_prompt_tokens": 12_000,
        "max_output_tokens": 4_000,
        "max_history_tokens": 4_800,
        "max_memory_tokens": 1_800,
        "max_profile_tokens": 900,
        "max_document_tokens": 6_000,
        "candidate_limit": 60,
        "evidence_item_limit": 12,
        "evidence_token_cap": 6_000,
        "query_variant_limit": 3,
        "retrieval_round_limit": 2,
        "dense_retrieval_allowed": True,
        "corrective_retrieval_allowed": True,
        "claim_verifier_allowed": True,
        "repository_retrieval_allowed": True,
        "repository_validation_allowed": True,
        "repository_contract_token_cap": 3_500,
        "repository_required_validation_categories": (
            "syntax", "lint", "typecheck", "test", "api_schema",
            "migration", "authorization",
        ),
        "persistent_knowledge_allowed": True,
        "triplet_retrieval_allowed": True,
        "hierarchical_retrieval_allowed": True,
        "knowledge_token_cap": 4_800,
        "hierarchy_summary_token_cap": 1_200,
    },
}


def _bounded_env_int(
    environ: Mapping[str, str],
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int,
) -> int:
    raw = str(environ.get(name, default)).strip()
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{name} is outside supported bounds")
    return value


def _build_policy(tier_id: TierId, environ: Mapping[str, str]) -> TierPolicy:
    values = dict(_BASE_POLICY[tier_id])
    prefix = f"WEB_RAG_{tier_id.upper()}"
    values["candidate_limit"] = _bounded_env_int(
        environ,
        f"{prefix}_CANDIDATE_LIMIT",
        int(values["candidate_limit"]),
        minimum=1,
        maximum=200,
    )
    values["evidence_item_limit"] = _bounded_env_int(
        environ,
        f"{prefix}_EVIDENCE_ITEM_LIMIT",
        int(values["evidence_item_limit"]),
        minimum=1,
        maximum=32,
    )
    values["evidence_token_cap"] = _bounded_env_int(
        environ,
        f"{prefix}_EVIDENCE_TOKEN_CAP",
        int(values["evidence_token_cap"]),
        minimum=128,
        maximum=int(values["max_prompt_tokens"]),
    )
    return TierPolicy(tier_id=tier_id, **values)  # type: ignore[arg-type]


def tier_policy_for(
    tier: object, environ: Mapping[str, str] | None = None
) -> TierPolicy:
    normalized = str(tier or "lite").strip().lower()
    if normalized not in _BASE_POLICY:
        normalized = "lite"
    return _build_policy(
        cast(TierId, normalized),
        os.environ if environ is None else environ,
    )


def validated_tier_policies(
    environ: Mapping[str, str] | None = None,
) -> tuple[TierPolicy, ...]:
    env = os.environ if environ is None else environ
    return tuple(_build_policy(tier, env) for tier in ("lite", "standard", "pro"))
