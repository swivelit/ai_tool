from __future__ import annotations

from dataclasses import dataclass

from ...web_api.upload_store import EphemeralUpload, EphemeralUploadStore
from ..evidence.models import EvidencePack
from ..evidence.pack_builder import build_evidence_pack
from ..execution_plan import ExecutionPlan
from ..settings import TriagSettings
from ..tier_policy import TierPolicy
from .corrective import CorrectiveRetrievalController
from .deduplication import deduplicate_candidates
from .dense import EmbeddingFunction, TemporaryDenseRetriever
from .evaluator import evaluate_retrieval
from .fusion import reciprocal_rank_fusion
from .lexical import LexicalAttachmentRetriever
from .registry import RetrievalRegistry
from .reranker import select_by_marginal_value


@dataclass(frozen=True)
class HybridRetrievalResult:
    pack: EvidencePack
    candidate_count: int
    corrective_rounds: int


def execute_hybrid_retrieval(
    *,
    plan: ExecutionPlan,
    policy: TierPolicy,
    settings: TriagSettings,
    owner_user_id: int,
    request_id: str,
    query: str,
    uploads: list[EphemeralUpload],
    store: EphemeralUploadStore,
    embed: EmbeddingFunction | None = None,
    dense_accounted: bool = False,
    cancellation_signal: object | None = None,
) -> HybridRetrievalResult:
    retrievers: list[object] = [LexicalAttachmentRetriever()]
    initial_statuses: list[str] = []
    if (
        settings.rag_dense_enabled
        and policy.dense_retrieval_allowed
        and dense_accounted
        and embed is not None
    ):
        retrievers.append(
            TemporaryDenseRetriever(
                store=store,
                embed=embed,
                model=settings.embedding_model,
                dimensions=settings.embedding_dimensions,
                query_cache_ttl_seconds=(
                    settings.query_embedding_cache_ttl_seconds
                ),
            )
        )
    elif settings.rag_dense_enabled and policy.dense_retrieval_allowed:
        initial_statuses.extend(
            ("embedding_budget_unavailable", "lexical_fallback")
        )
    registry = RetrievalRegistry(tuple(retrievers))  # type: ignore[arg-type]
    run = registry.execute(
        plan=plan,
        query=query,
        uploads=uploads,
        owner_user_id=owner_user_id,
        candidate_limit=policy.candidate_limit,
        cancellation_signal=cancellation_signal,
    )
    fused = reciprocal_rank_fusion(
        run.result_sets, limit=policy.candidate_limit
    )
    deduplicated = deduplicate_candidates(fused)
    selected = select_by_marginal_value(
        deduplicated,
        item_limit=policy.evidence_item_limit,
        token_cap=policy.evidence_token_cap,
    )
    if settings.retrieval_evaluator_enabled:
        status, contradictions = evaluate_retrieval(selected)
    else:
        basic_support = max(
            (
                max(
                    item.lexical_score,
                    item.semantic_score,
                    item.metadata_score,
                )
                for item in selected
            ),
            default=0.0,
        )
        status, contradictions = (
            ("sufficient", ()) if basic_support >= 0.08
            else ("insufficient", ())
        )
    corrective = CorrectiveRetrievalController(
        policy=policy,
        configured_max_rounds=settings.max_corrective_rounds,
    )
    corrective_query = (
        corrective.next_query(query=query, status=status)
        if settings.retrieval_evaluator_enabled
        else None
    )
    status_codes = list(initial_statuses) + list(run.status_codes)
    if corrective_query is not None:
        correction = RetrievalRegistry(
            (LexicalAttachmentRetriever(),),
            max_concurrency=1,
        ).execute(
            plan=plan,
            query=corrective_query,
            uploads=uploads,
            owner_user_id=owner_user_id,
            candidate_limit=policy.candidate_limit,
            cancellation_signal=cancellation_signal,
        )
        fused = reciprocal_rank_fusion(
            (*run.result_sets, *correction.result_sets),
            limit=policy.candidate_limit,
        )
        deduplicated = deduplicate_candidates(fused)
        selected = select_by_marginal_value(
            deduplicated,
            item_limit=policy.evidence_item_limit,
            token_cap=policy.evidence_token_cap,
        )
        status, contradictions = evaluate_retrieval(selected)
        status_codes.extend(("corrective_round", *correction.status_codes))
    pack = build_evidence_pack(
        owner_user_id=owner_user_id,
        request_id=request_id,
        candidates=selected,
        status=status,
        contradictions=contradictions,
        status_codes=tuple(dict.fromkeys(status_codes)),
        token_cap=policy.evidence_token_cap,
    )
    return HybridRetrievalResult(
        pack=pack,
        candidate_count=len(deduplicated),
        corrective_rounds=corrective.completed_rounds,
    )
