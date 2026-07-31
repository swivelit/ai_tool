from __future__ import annotations

from dataclasses import dataclass
import re

from ..ai.intent import classify_intent_with_metadata
from ..billing.pricing import estimate_tokens
from ..web_api.conversation_continuity import SameThreadContinuityDecision
from ..web_api.turn_optimizer import optimize_web_turn
from .execution_plan import ExecutionPlan
from .settings import TriagSettings
from .telemetry.metadata import sanitize_metadata
from .tier_policy import tier_policy_for
from .token_allocator import DynamicTokenAllocator


@dataclass(frozen=True)
class AttachmentMetadata:
    count: int = 0
    total_bytes: int = 0
    media_categories: tuple[str, ...] = ()
    has_extracted_chunks: bool = False

    def __post_init__(self) -> None:
        if self.count < 0 or self.total_bytes < 0:
            raise ValueError("attachment counts must be non-negative")


@dataclass(frozen=True)
class TriageInput:
    message: str
    selected_tier: str
    reply_language: str | None
    continuity: SameThreadContinuityDecision
    attachment_metadata: AttachmentMetadata = AttachmentMetadata()
    needs_cross_thread_memory: bool = False
    profile_available: bool = False
    history_available_tokens: int = 0
    memory_available_tokens: int = 0
    profile_available_tokens: int = 0
    document_available_tokens: int = 0
    previous_topic: str | None = None
    repository_available: bool = False
    persistent_knowledge_available_tokens: int = 0


def _media_category(media_type: object) -> str:
    normalized = str(media_type or "").strip().lower()
    category = normalized.split("/", 1)[0] if "/" in normalized else normalized
    return category if category in {"text", "image", "audio", "video", "application"} else "other"


def attachment_metadata_from_uploads(uploads: list[object]) -> AttachmentMetadata:
    categories = tuple(sorted({
        _media_category(getattr(upload, "media_type", ""))
        for upload in uploads
    }))
    return AttachmentMetadata(
        count=len(uploads),
        total_bytes=sum(
            max(0, int(getattr(upload, "size_bytes", 0) or 0))
            for upload in uploads
        ),
        media_categories=categories,
        has_extracted_chunks=any(
            bool(getattr(upload, "chunks", ())) for upload in uploads
        ),
    )


def build_execution_plan(
    triage_input: TriageInput,
    *,
    settings: TriagSettings | None = None,
) -> ExecutionPlan:
    """Build a repeatable plan without provider or embedding calls."""

    config = settings or TriagSettings.from_environ()
    policy = tier_policy_for(triage_input.selected_tier)
    attachments = triage_input.attachment_metadata
    intent_decision = classify_intent_with_metadata(triage_input.message)
    optimization = optimize_web_turn(
        triage_input.message,
        reply_language=triage_input.reply_language,
        has_attachments=attachments.count > 0,
        previous_topic=triage_input.previous_topic,
        continuity=triage_input.continuity,
    )
    deterministic = bool(optimization.local_intent)
    repository_task = bool(
        re.search(
            r"\b(?:repository|repo|codebase|source|file|module|class|function|"
            r"debug|bug|fix|implement|refactor|test|typecheck|lint)\b",
            triage_input.message,
            re.IGNORECASE,
        )
        and re.search(
            r"\b(?:code|repository|repo|codebase|file|module|class|function|"
            r"debug|bug|fix|implement|refactor|test|typecheck|lint)\b",
            triage_input.message,
            re.IGNORECASE,
        )
    )
    blocked = optimization.optimization_route == "safety_block"
    route = (
        "blocked"
        if blocked
        else "deterministic"
        if deterministic
        else "cache_candidate"
        if optimization.cache_eligible
        else "provider_backed"
    )
    profile_relevant = bool(
        triage_input.profile_available
        and not deterministic
        and intent_decision.intent
        in {
            "profile",
            "settings",
        }
    )
    relevance = {
        "history": (
            1.0
            if triage_input.continuity.use_context
            and triage_input.history_available_tokens > 0
            and not deterministic
            else 0.0
        ),
        "memory": (
            1.0
            if triage_input.needs_cross_thread_memory
            and triage_input.memory_available_tokens > 0
            and not deterministic
            else 0.0
        ),
        "profile": 0.7 if profile_relevant else 0.0,
        "documents": (
            1.0
            if (
                (
                    attachments.count > 0
                    and triage_input.document_available_tokens > 0
                )
                or (
                    triage_input.persistent_knowledge_available_tokens > 0
                    and config.persistent_knowledge_runtime_enabled
                    and policy.persistent_knowledge_allowed
                )
            )
            and not deterministic
            else 0.0
        ),
        "repository": (
            1.0
            if repository_task
            and triage_input.repository_available
            and config.repository_chat_runtime_enabled
            and policy.repository_retrieval_allowed
            else 0.0
        ),
    }
    fixed_tokens = min(
        policy.max_prompt_tokens,
        estimate_tokens(triage_input.message) + 320,
    )
    allocation = DynamicTokenAllocator(policy).allocate(
        fixed_tokens=fixed_tokens,
        relevance=relevance,
        available_tokens={
            "history": triage_input.history_available_tokens,
            "memory": triage_input.memory_available_tokens,
            "profile": triage_input.profile_available_tokens,
            "documents": (
                triage_input.document_available_tokens
                + min(
                    policy.knowledge_token_cap,
                    triage_input.persistent_knowledge_available_tokens,
                )
            ),
        },
    )
    retrieval_sources = tuple(
        source
        for source, token_count in (
            ("history", allocation.history_tokens),
            ("memory", allocation.memory_tokens),
            ("profile", allocation.profile_tokens),
            ("documents", allocation.document_tokens),
        )
        if token_count > 0
    )
    if relevance["repository"] > 0:
        retrieval_sources = (*retrieval_sources, "repository")
    knowledge_planned = bool(
        triage_input.persistent_knowledge_available_tokens > 0
        and config.persistent_knowledge_runtime_enabled
        and policy.persistent_knowledge_allowed
        and allocation.document_tokens > 0
        and not deterministic
    )
    if knowledge_planned:
        retrieval_sources = (*retrieval_sources, "knowledge")
        if config.triplet_runtime_enabled and policy.triplet_retrieval_allowed:
            retrieval_sources = (*retrieval_sources, "triplets")
        if (
            config.hierarchy_runtime_enabled
            and policy.hierarchical_retrieval_allowed
        ):
            retrieval_sources = (*retrieval_sources, "hierarchy")
    dense_planned = bool(
        not deterministic
        and not blocked
        and (
            "documents" in retrieval_sources
            or "knowledge" in retrieval_sources
        )
        and config.dense_runtime_enabled
        and policy.dense_retrieval_allowed
    )
    guard_planned = bool(
        not deterministic
        and not blocked
        and config.answer_guard_runtime_enabled
    )
    repository_validation_planned = bool(
        repository_task
        and "repository" in retrieval_sources
        and config.code_validation_runtime_enabled
        and policy.repository_validation_allowed
    )
    verifier_planned = bool(
        guard_planned
        and (
            "documents" in retrieval_sources
            or "knowledge" in retrieval_sources
        )
        and config.model_claim_verifier_enabled
        and policy.claim_verifier_allowed
    )
    repair_planned = bool(
        guard_planned and config.answer_repair_enabled
    )
    expected_calls = (
        0
        if deterministic or blocked
        else (
            1
            + int(dense_planned)
            + int(verifier_planned)
            + int(repair_planned)
        )
    )
    reasons = (
        optimization.optimization_route,
        triage_input.continuity.reason,
    )
    return ExecutionPlan(
        policy_version=config.policy_version,
        tier_id=policy.tier_id,
        route=route,
        intent=intent_decision.intent,
        answer_class=optimization.answer_class,
        reason_codes=tuple(reason for reason in reasons if reason),
        retrieval_sources=retrieval_sources,
        token_allocation=allocation,
        max_output_tokens=min(
            policy.max_output_tokens, optimization.max_output_tokens
        ),
        expected_provider_calls=expected_calls,
        cache_eligible=optimization.cache_eligible and not knowledge_planned,
        deterministic=deterministic or blocked,
        streaming_mode=(
            "none"
            if deterministic or blocked
            else "verified_buffered"
            if guard_planned
            and config.verified_streaming_runtime_enabled
            and (
                "documents" in retrieval_sources
                or "knowledge" in retrieval_sources
                or optimization.answer_class in {"detailed", "long_form"}
            )
            else "direct"
            if guard_planned
            else "existing_sse"
        ),
        planned_usage_stages=(
            ()
            if expected_calls == 0
            else tuple(
                stage
                for stage, included in (
                    ("embedding", dense_planned),
                    ("reservation", True),
                    ("generation", True),
                    ("verifier", verifier_planned),
                    ("repository_validation", repository_validation_planned),
                    ("repair", repair_planned),
                    ("settlement", True),
                )
                if included
            )
        ),
    )


def shadow_metadata(
    plan: ExecutionPlan, attachments: AttachmentMetadata
) -> dict[str, object]:
    raw = {
        **plan.sanitized_metadata,
        "attachment_count": attachments.count,
        "attachment_bytes": attachments.total_bytes,
        "attachment_media_categories": list(attachments.media_categories),
        "has_extracted_attachment_chunks": attachments.has_extracted_chunks,
        "shadow_mode": True,
        "status": "planned",
    }
    return sanitize_metadata(raw)
