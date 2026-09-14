from __future__ import annotations

from dataclasses import replace

from ...web_api.attachment_context import UNTRUSTED_ATTACHMENT_INSTRUCTION
from ..retrieval.models import RetrievalCandidate
from .citation_map import build_source_map
from .compressor import compress_runtime_text
from .models import EvidenceItem, EvidencePack, RetrievalStatus


def build_evidence_pack(
    *,
    owner_user_id: int,
    request_id: str,
    candidates: tuple[RetrievalCandidate, ...],
    status: RetrievalStatus,
    contradictions: tuple[str, ...] = (),
    status_codes: tuple[str, ...] = (),
    token_cap: int,
) -> EvidencePack:
    items: list[EvidenceItem] = []
    remaining = max(0, int(token_cap))
    representative_coverage = any(
        dict(candidate.bounded_metadata).get("coverage_mode") == "representative"
        and dict(candidate.bounded_metadata).get("coverage_complete") != "true"
        for candidate in candidates
    )
    truncated = representative_coverage
    effective_status_codes = list(status_codes)
    if representative_coverage:
        effective_status_codes.append("representative_coverage")
    for candidate in candidates:
        if remaining <= 0:
            truncated = True
            break
        text, tokens, clipped = compress_runtime_text(
            candidate.runtime_text, remaining
        )
        if not text:
            continue
        label = f"S{len(items) + 1}"
        metadata = dict(candidate.bounded_metadata)
        source_label = metadata.get(
            "source_label", metadata.get("upload_name", "Uploaded document")
        )
        item = EvidenceItem(
            evidence_id=candidate.candidate_id,
            owner_user_id=owner_user_id,
            source_type=candidate.source_kind,
            source_id=candidate.source_locator,
            ordinal=len(items),
            estimated_tokens=tokens,
            relevance_score=candidate.fused_score,
            citation_label=label,
            source_label=source_label,
            source_locator=candidate.source_locator,
            confidence=candidate.fused_score,
            runtime_text=text,
            content_hash=candidate.content_hash,
            safe_attributes=tuple(
                (key, value)
                for key, value in candidate.bounded_metadata
                if key in {
                    "upload_id", "upload_name", "chunk_index",
                    "document_id", "chunk_id", "raw_chunk_id",
                    "source_version", "extraction_version", "cache_scope",
                    "coverage_mode", "coverage_complete", "retrieved_at",
                    "provenance", "claim_support_type", "verification_strength",
                    "independent_verification", "temporal_support_strength",
                }
            ),
        )
        items.append(item)
        remaining -= tokens
        truncated = truncated or clipped
    immutable_items = tuple(items)
    return EvidencePack(
        owner_user_id=owner_user_id,
        request_id=request_id,
        items=immutable_items,
        total_token_count=sum(item.estimated_tokens for item in immutable_items),
        truncated=truncated,
        retrieval_status=status,
        contradictions=contradictions,
        source_map=build_source_map(immutable_items),
        status_codes=tuple(dict.fromkeys(effective_status_codes)),
    )


def evidence_prompt(pack: EvidencePack) -> str:
    blocks = [
        f"[{item.citation_label}: {item.source_label} — {item.source_locator}]\n"
        f"{item.runtime_text}"
        for item in pack.items
    ]
    status_instruction = (
        "The retrieved evidence is insufficient. State explicitly that the supplied "
        "sources do not provide the requested fact and that it cannot be determined "
        "from the available evidence. Do not answer the fact, infer a value, use "
        "outside knowledge, or guess."
        if pack.retrieval_status == "insufficient"
        else (
            "Use only supported statements. Before answering each requested fact, "
            "locate direct support for that fact in the supplied evidence. If a "
            "requested fact is absent, say explicitly that the sources do not provide "
            "it; do not infer it, fill it from outside knowledge, or invent a value. "
            "Every factual answer section must "
            "include one or more citations in the exact form [S1], [S2], using "
            "only the supplied S identifiers. Do not cite a source that does not "
            "support the statement."
        )
    )
    coverage_instruction = (
        "Coverage is representative excerpts only; the complete document was not "
        "processed. State that limitation and do not claim a full-document review."
        if pack.truncated or "representative_coverage" in pack.status_codes
        else ""
    )
    return "\n\n".join(
        [UNTRUSTED_ATTACHMENT_INSTRUCTION, status_instruction, coverage_instruction, *blocks]
    )


def cap_evidence_pack(pack: EvidencePack, token_cap: int) -> EvidencePack:
    remaining = max(0, int(token_cap))
    items: list[EvidenceItem] = []
    truncated = pack.truncated
    for original in pack.items:
        if remaining <= 0:
            truncated = True
            break
        text, tokens, clipped = compress_runtime_text(
            original.runtime_text, remaining
        )
        if not text:
            continue
        items.append(
            replace(
                original,
                runtime_text=text,
                estimated_tokens=tokens,
                ordinal=len(items),
                citation_label=f"S{len(items) + 1}",
            )
        )
        remaining -= tokens
        truncated = truncated or clipped
    immutable = tuple(items)
    return replace(
        pack,
        items=immutable,
        total_estimated_tokens=sum(item.estimated_tokens for item in immutable),
        total_token_count=sum(item.estimated_tokens for item in immutable),
        truncated=truncated,
        source_map=build_source_map(immutable),
    )
