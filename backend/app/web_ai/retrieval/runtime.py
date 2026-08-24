from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable

from sqlmodel import Session

from ...web_api.upload_store import EphemeralUpload, EphemeralUploadStore
from ..evidence.models import EvidencePack
from ..evidence.pack_builder import build_evidence_pack
from ..evidence.compressor import compress_runtime_text
from ..execution_plan import ExecutionPlan
from ..planners import RequestPlan, RetrievalTriagPlanner
from ..settings import TriagSettings
from ..tier_policy import TierPolicy
from .corrective import CorrectiveRetrievalController
from .deduplication import deduplicate_candidates
from .dense import EmbeddingFunction, TemporaryDenseRetriever
from .evaluator import evaluate_retrieval
from .fusion import reciprocal_rank_fusion
from .lexical import LexicalAttachmentRetriever
from .hierarchical import HierarchicalRetriever
from .models import RetrievalCandidate
from .persistent_knowledge import PersistentKnowledgeRetriever
from .registry import RetrievalRegistry, RetrievalRun
from .reranker import select_by_marginal_value
from .triplet import TripletRetriever


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
    query_embed: EmbeddingFunction | None = None,
    dense_accounted: bool = False,
    knowledge_session_factory: Callable[[], Session] | None = None,
    cancellation_signal: object | None = None,
) -> HybridRetrievalResult:
    retrievers: list[object] = [LexicalAttachmentRetriever()]
    deferred_dense: object | None = None
    initial_statuses: list[str] = []
    if (
        settings.rag_dense_enabled
        and policy.dense_retrieval_allowed
        and dense_accounted
        and embed is not None
    ):
        dense_retriever = TemporaryDenseRetriever(
                store=store,
                embed=embed,
                query_embed=query_embed,
                model=settings.embedding_model,
                dimensions=settings.embedding_dimensions,
                query_cache_ttl_seconds=(
                    settings.query_embedding_cache_ttl_seconds
                ),
            )
        if policy.tier_id == "lite":
            # Lite is lexical-first. Dense is an explicit fallback only when
            # lexical retrieval did not produce useful support.
            deferred_dense = dense_retriever
        else:
            retrievers.append(dense_retriever)
    elif settings.rag_dense_enabled and policy.dense_retrieval_allowed:
        initial_statuses.extend(
            ("embedding_budget_unavailable", "lexical_fallback")
        )
    if (
        knowledge_session_factory is not None
        and settings.persistent_knowledge_runtime_enabled
        and policy.persistent_knowledge_allowed
        and "knowledge" in plan.retrieval_sources
    ):
        query_embedding = None
        if (
            settings.rag_dense_enabled
            and policy.dense_retrieval_allowed
            and dense_accounted
            and embed is not None
        ):
            def query_embedding(value: str) -> list[float]:
                vectors = (query_embed or embed)((value,))
                return [float(item) for item in (vectors[0] if vectors else ())]
        retrievers.append(
            PersistentKnowledgeRetriever(
                knowledge_session_factory,
                query_embedding=query_embedding,
                dense_accounted=dense_accounted,
            )
        )
        if (
            settings.triplet_runtime_enabled
            and policy.triplet_retrieval_allowed
            and "triplets" in plan.retrieval_sources
        ):
            retrievers.append(TripletRetriever(knowledge_session_factory))
        if (
            settings.hierarchy_runtime_enabled
            and policy.hierarchical_retrieval_allowed
            and "hierarchy" in plan.retrieval_sources
        ):
            retrievers.append(HierarchicalRetriever(knowledge_session_factory))
    registry = RetrievalRegistry(tuple(retrievers))  # type: ignore[arg-type]
    run = registry.execute(
        plan=plan,
        query=query,
        uploads=uploads,
        owner_user_id=owner_user_id,
        candidate_limit=policy.candidate_limit,
        cancellation_signal=cancellation_signal,
    )
    if deferred_dense is not None and not _lexical_support_sufficient(run):
        dense_run = RetrievalRegistry((deferred_dense,), max_concurrency=1).execute(
            plan=plan,
            query=query,
            uploads=uploads,
            owner_user_id=owner_user_id,
            candidate_limit=policy.candidate_limit,
            cancellation_signal=cancellation_signal,
        )
        run = RetrievalRun(
            (*run.result_sets, *dense_run.result_sets),
            tuple(dict.fromkeys((*run.status_codes, *dense_run.status_codes))),
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
    selected = _cap_knowledge_candidates(
        selected, token_cap=policy.knowledge_token_cap
    )
    status, contradictions = _evaluate_selected(selected, settings)
    request_plan = RequestPlan(
        intent=plan.intent,
        answer_class=plan.answer_class,
        route=(
            "deterministic" if plan.route == "deterministic"
            else "blocked" if plan.route == "blocked"
            else "cache" if plan.route == "cache_candidate"
            else "provider"
        ),
        query_variants=(query[:2_000],),
        reason="runtime_execution_plan",
    )
    evidence_plan = RetrievalTriagPlanner().plan(
        request_plan,
        policy=policy,
        settings=settings,
    )
    corrective = CorrectiveRetrievalController(
        policy=policy,
        configured_max_rounds=evidence_plan.corrective_round_limit,
    )
    status_codes = list(initial_statuses) + list(run.status_codes)
    # Corrective retrieval is deliberately evaluator-gated, as in the
    # existing path.  The controller supplies the tier bound: Standard can
    # perform one round and Pro can perform two, while Free/Lite are capped at
    # zero by policy.
    while settings.retrieval_evaluator_enabled:
        corrective_query = corrective.next_query(query=query, status=status)
        if corrective_query is None:
            break
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
        run = RetrievalRun(
            (*run.result_sets, *correction.result_sets),
            tuple(dict.fromkeys((*run.status_codes, *correction.status_codes))),
        )
        fused = reciprocal_rank_fusion(
            run.result_sets,
            limit=policy.candidate_limit,
        )
        deduplicated = deduplicate_candidates(fused)
        selected = select_by_marginal_value(
            deduplicated,
            item_limit=policy.evidence_item_limit,
            token_cap=policy.evidence_token_cap,
        )
        selected = _cap_knowledge_candidates(
            selected, token_cap=policy.knowledge_token_cap
        )
        status, contradictions = _evaluate_selected(selected, settings)
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


def _evaluate_selected(
    selected: tuple[RetrievalCandidate, ...],
    settings: TriagSettings,
) -> tuple[str, tuple[str, ...]]:
    if settings.retrieval_evaluator_enabled:
        return evaluate_retrieval(selected)
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
    return (
        ("sufficient", ()) if basic_support >= 0.08
        else ("insufficient", ())
    )


def _cap_knowledge_candidates(
    candidates: tuple[RetrievalCandidate, ...], *, token_cap: int
) -> tuple[RetrievalCandidate, ...]:
    """Apply the central per-tier private-knowledge cap before pack building."""

    remaining = max(0, int(token_cap))
    output: list[RetrievalCandidate] = []
    for candidate in candidates:
        source_kind = str(getattr(candidate, "source_kind", ""))
        if source_kind not in {
            "persistent_knowledge",
            "knowledge_triplet",
        }:
            output.append(candidate)
            continue
        if remaining <= 0:
            continue
        runtime_text, tokens, _ = compress_runtime_text(
            str(getattr(candidate, "runtime_text", "")), remaining
        )
        if not runtime_text:
            continue
        output.append(
            replace(
                candidate,
                runtime_text=runtime_text,
                token_count=tokens,
                estimated_tokens=tokens,
            )
        )
        remaining -= tokens
    return tuple(output)


def _lexical_support_sufficient(run: RetrievalRun) -> bool:
    """Return true when lexical evidence is strong enough to skip dense search."""

    return any(
        max(
            float(getattr(item, "lexical_score", 0.0) or 0.0),
            float(getattr(item, "metadata_score", 0.0) or 0.0),
        ) >= 0.08
        for result_set in run.result_sets
        for item in result_set
    )
