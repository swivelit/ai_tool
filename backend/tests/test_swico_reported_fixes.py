from datetime import datetime, timezone

from app.ai.freshness import resolve_freshness
from app.ai.language import resolve_web_reply_language
from app.web_ai.generation.quality_gate import quality_outcome
from app.web_ai.generation.models import QualityCheck
from app.web_api.attachment_context import is_document_overview_request, select_attachment_context
from app.web_api.upload_store import EphemeralUpload, ExtractedChunk


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
