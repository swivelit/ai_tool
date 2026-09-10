from dataclasses import replace
from datetime import datetime, timezone

from app.ai.freshness import resolve_freshness
from app.ai.language import resolve_web_reply_language
from app.web_ai.generation.quality_gate import quality_outcome
from app.web_ai.generation.models import QualityCheck
from app.web_api.attachment_context import is_document_overview_request, select_attachment_context
from app.web_api.upload_store import EphemeralUpload, ExtractedChunk
from app.web_ai.evidence.pack_builder import build_evidence_pack, evidence_prompt
from app.web_ai.retrieval.lexical import LexicalAttachmentRetriever
from app.web_ai.retrieval.runtime import execute_hybrid_retrieval
from app.web_ai.retrieval.models import RetrievalCandidate
from app.web_ai.retrieval.reranker import select_by_marginal_value
from app.web_ai.execution_plan import ExecutionPlan
from app.web_ai.settings import TriagSettings
from app.web_ai.tier_policy import tier_policy_for
from app.web_ai.token_allocator import TokenAllocation
from app.web_api.upload_store import InProcessEphemeralUploadStore


def _upload() -> EphemeralUpload:
    return EphemeralUpload(
        id="overview-upload", owner_user_id=1, name="review.pdf", extension=".pdf",
        media_type="application/pdf", size_bytes=100,
        created_at="2026-09-10T00:00:00+00:00",
        expires_at="2026-09-10T00:05:00+00:00",
        chunks=[
            ExtractedChunk(text="opening section", source="page 1"),
            ExtractedChunk(text="middle section", source="page 4"),
            ExtractedChunk(text="later section", source="page 8"),
        ], source_locators=[], warnings=[],
    )


def test_effective_reply_language_overrides_saved_preference_without_place_false_positive():
    assert resolve_web_reply_language("ta", "Give me the result in english") == "en"
    assert resolve_web_reply_language("ta", "Tamil la sollu") == "ta"
    assert resolve_web_reply_language("ta", "Latest news in Tamil Nadu") == "ta"
    assert resolve_web_reply_language("ta", "Explain English grammar") == "ta"


def test_freshness_uses_server_date_and_distinguishes_historical_officeholder():
    now = datetime(2026, 9, 10, tzinfo=timezone.utc)
    current = resolve_freshness("Who is the president of India?", now=now)
    historical = resolve_freshness("Who was president of India in 2020?", now=now)
    assert current.requires_fresh_evidence is True
    assert current.scope == "current" and current.as_of == "2026-09-10"
    assert historical.requires_fresh_evidence is False
    assert historical.scope == "historical"


def test_document_overview_uses_representative_coverage_and_labels_limit(monkeypatch):
    monkeypatch.setenv("WEB_ATTACHMENT_PROMPT_MAX_CHARS", "2000")
    assert is_document_overview_request("Please go through the PDF") is True
    selected = select_attachment_context([_upload()], "Please go through the PDF")
    assert "representative excerpts only" in selected
    assert "page 1" in selected and "page 4" in selected and "page 8" in selected


def test_structural_buffering_is_checked_not_factually_verified():
    checks = (QualityCheck("format", "passed"),)
    assert quality_outcome(
        checks=checks, evidence_backed=False, verified_buffered=True,
        repository_validation_required=False,
    ) == "checked"
    assert quality_outcome(
        checks=checks, evidence_backed=True, verified_buffered=True,
        repository_validation_required=False,
    ) == "grounded"


def test_targeted_document_fact_is_not_promoted_to_overview():
    assert is_document_overview_request("Read this document and tell me the CEO salary") is False


def test_representative_coverage_is_source_ordered_across_files_and_rebuilt_prompt():
    first = _upload()
    second = EphemeralUpload(
        **{**first.__dict__, "id": "second", "name": "second.pdf",
           "chunks": [
               ExtractedChunk(text="second opening", source="page 1"),
               ExtractedChunk(text="second middle", source="page 5"),
               ExtractedChunk(text="second later", source="page 9"),
           ]},
    )
    candidates = LexicalAttachmentRetriever().retrieve(
        query="Please go through the PDFs", uploads=[first, second],
        owner_user_id=1, limit=5,
    )
    assert [candidate.source_locator.split(" — ")[0] for candidate in candidates] == [
        "review.pdf", "second.pdf", "review.pdf", "second.pdf", "review.pdf",
    ]
    pack = build_evidence_pack(
        owner_user_id=1, request_id="coverage", candidates=candidates,
        status="sufficient", token_cap=2_000,
    )
    prompt = evidence_prompt(pack)
    assert pack.truncated is True
    assert "representative excerpts only" in prompt


def test_hybrid_lite_overview_keeps_all_files_through_final_pack_selection():
    uploads = [
        EphemeralUpload(
            id=f"overview-{index}", owner_user_id=1, name=f"file-{index}.pdf",
            extension=".pdf", media_type="application/pdf", size_bytes=100,
            created_at="2026-09-10T00:00:00+00:00",
            expires_at="2026-09-10T00:05:00+00:00",
            chunks=[ExtractedChunk(text=f"file {index} section {part}", source=f"page {part}") for part in range(1, 4)],
            source_locators=[], warnings=[],
        )
        for index in (1, 2, 3)
    ]
    base_policy = tier_policy_for("lite")
    policy = replace(base_policy, candidate_limit=12, evidence_item_limit=4, evidence_token_cap=40)
    plan = ExecutionPlan(
        policy_version="v1", tier_id="lite", route="provider_backed", intent="document",
        answer_class="normal", reason_codes=(), retrieval_sources=("documents",),
        token_allocation=TokenAllocation(4096, 100, document_tokens=300),
        max_output_tokens=512, expected_provider_calls=1, cache_eligible=False,
        deterministic=False, streaming_mode="existing_sse", planned_usage_stages=(),
    )
    result = execute_hybrid_retrieval(
        plan=plan, policy=policy, settings=TriagSettings(), owner_user_id=1,
        request_id="hybrid-overview", query="Please go through the PDFs",
        uploads=uploads, store=InProcessEphemeralUploadStore(),
    )
    names = [item.source_label for item in result.pack.items]
    assert set(names) == {"file-1.pdf", "file-2.pdf", "file-3.pdf"}
    assert result.pack.truncated is True
    assert "representative excerpts only" in evidence_prompt(result.pack)


def test_final_overview_selection_reserves_affordable_coverage_before_depth():
    def candidate(name: str, upload: str, index: int, tokens: int) -> RetrievalCandidate:
        return RetrievalCandidate(
            candidate_id=name, owner_user_id=1, source_kind="document",
            source_locator=f"{upload} — page {index}", runtime_text=(name + " ") * tokens,
            token_count=tokens, fused_score=0.8,
            bounded_metadata=(
                ("coverage_mode", "representative"),
                ("coverage_complete", "false"),
                ("upload_id", upload), ("upload_index", str({"a": 0, "b": 1, "c": 2}[upload])),
                ("upload_name", f"{upload}.pdf"), ("chunk_index", str(index)),
            ),
        )

    candidates = tuple(
        [candidate("a1", "a", 1, 500), candidate("a2", "a", 2, 50), candidate("a3", "a", 3, 50)]
        + [candidate("b1", "b", 1, 500), candidate("b2", "b", 2, 500), candidate("b3", "b", 3, 500)]
        + [candidate("c1", "c", 1, 300), candidate("c2", "c", 2, 300), candidate("c3", "c", 3, 300)]
    )
    selected = select_by_marginal_value(candidates, item_limit=4, token_cap=1200)
    pack = build_evidence_pack(
        owner_user_id=1, request_id="unequal-coverage", candidates=selected,
        status="sufficient", token_cap=1200,
    )
    assert {item.source_label for item in pack.items} == {"a.pdf", "b.pdf", "c.pdf"}
    assert [item.evidence_id for item in pack.items[:3]] == ["a2", "b1", "c1"]
    assert pack.truncated is True
    assert "representative excerpts only" in evidence_prompt(pack)
