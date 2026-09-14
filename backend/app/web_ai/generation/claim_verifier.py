from __future__ import annotations

import re
from collections.abc import Callable

from ...ai.providers.base import GenerationCancelled
from ..evidence.models import EvidencePack
from .models import QualityCheck


_WORD = re.compile(r"[\w\u0B80-\u0BFF]+", re.UNICODE)
_CITATION = re.compile(r"\[(S[1-9][0-9]*)\]")
_HEADING = re.compile(r"^\s*#{1,6}\s+(.+?)\s*$", re.MULTILINE)
_STOP = {
    "about", "after", "also", "and", "are", "because", "been", "before",
    "but", "can", "could", "for", "from", "has", "have", "into", "its",
    "more", "not", "that", "the", "their", "then", "there", "these", "this",
    "was", "were", "which", "with", "would", "your",
}
_WEB_DATE = re.compile(
    r"\b(?:January|February|March|April|May|June|July|August|September|"
    r"October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b(?:19|20)\d{2}\b",
    re.IGNORECASE,
)
_WEB_NAME = re.compile(
    r"\b(?:[A-Z]\.?\s*)?[A-Z][A-Za-z\u0080-\uffff'’-]+"
    r"(?:\s+(?:[A-Z]\.?\s*)?[A-Z][A-Za-z\u0080-\uffff'’-]+){0,3}\b"
)
_WEB_NAME_STOP = {
    "The", "This", "That", "Chief", "Prime", "Minister", "Tamil", "Nadu",
    "Current", "Currently", "According", "As", "On", "In", "May", "June",
    "January", "February", "March", "April", "July", "August", "September",
    "October", "November", "December",
}


def citation_ids(answer: str) -> tuple[str, ...]:
    return tuple(_CITATION.findall(str(answer or "")))


def factual_sections(answer: str) -> tuple[str, ...]:
    sections: list[str] = []
    in_fence = False
    for section in re.split(r"\n{2,}", str(answer or "")):
        if section.strip().startswith("```"):
            in_fence = not in_fence
            continue
        plain = _HEADING.sub("", section).strip()
        if (
            not in_fence
            and len(plain.split()) >= 7
            and re.search(r"[A-Za-z\u0B80-\u0BFF]", plain)
        ):
            sections.append(plain)
    return tuple(sections)


def deterministic_evidence_support(
    answer: str,
    evidence_pack: EvidencePack,
) -> QualityCheck:
    evidence = {
        item.citation_label: {
            token for token in _WORD.findall(item.runtime_text.lower())
            if len(token) > 2 and token not in _STOP
        }
        for item in evidence_pack.items
    }
    cited_sections = 0
    supported_sections = 0
    for section in re.split(r"\n{2,}", str(answer or "")):
        ids = _CITATION.findall(section)
        if not ids:
            continue
        cited_sections += 1
        claim_terms = {
            token for token in _WORD.findall(_CITATION.sub("", section).lower())
            if len(token) > 2 and token not in _STOP
        }
        if any(claim_terms & evidence.get(source_id, set()) for source_id in ids):
            supported_sections += 1
    if cited_sections and cited_sections == supported_sections:
        return QualityCheck("evidence_support", "passed")
    if not cited_sections and not factual_sections(answer):
        return QualityCheck(
            "evidence_support", "skipped", "no_cited_sections"
        )
    return QualityCheck(
        "evidence_support",
        "failed",
        "unsupported_cited_section" if cited_sections else "no_cited_sections",
    )


def _web_sentences(paragraph: str) -> tuple[str, ...]:
    """Split a cited paragraph while keeping trailing citation markers attached."""
    chunks: list[str] = []
    start = 0
    for match in re.finditer(r"[.!?](?:\s+|$)", paragraph):
        end = match.end()
        marker = re.match(r"\s*(?:\[S\d+\]\s*)+", paragraph[end:])
        if marker:
            end += marker.end()
        chunk = paragraph[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end
    tail = paragraph[start:].strip()
    if tail:
        chunks.append(tail)
    return tuple(chunks)


def _web_sentence_supports(sentence: str, runtime_text: str) -> bool:
    answer = _CITATION.sub("", sentence).strip()
    if not answer:
        return True
    evidence_terms = {
        token for token in _WORD.findall(runtime_text.lower())
        if len(token) > 2 and token not in _STOP
    }
    answer_terms = {
        token for token in _WORD.findall(answer.lower())
        if len(token) > 2 and token not in _STOP
    }
    if not answer_terms:
        return True
    if not answer_terms.intersection(evidence_terms):
        return False
    # _WEB_DATE has an outer capture for years; use complete matched spans so
    # named dates and their day remain bound together.
    date_spans = {
        match.group(0).casefold().replace(",", "")
        for match in _WEB_DATE.finditer(answer)
    }
    evidence_folded = runtime_text.casefold().replace(",", "")
    if any(span not in evidence_folded for span in date_spans):
        return False
    for match in _WEB_NAME.finditer(answer):
        name = " ".join(match.group(0).split())
        parts = name.split()
        if len(parts) < 2 or all(part.rstrip(".") in _WEB_NAME_STOP for part in parts):
            continue
        if name.casefold() not in evidence_folded:
            return False
    overlap = len(answer_terms & evidence_terms) / max(1, len(answer_terms))
    return overlap >= 0.6


def web_evidence_support(
    answer: str,
    evidence_pack: EvidencePack,
) -> QualityCheck:
    """Check web-grounded answer claims without treating topic overlap as proof."""
    web_items = {
        item.citation_label: item.runtime_text
        for item in evidence_pack.items
        if item.source_type == "web_search"
    }
    if not web_items:
        return QualityCheck("web_evidence_support", "skipped", "not_web_evidence")
    cited_sentences = 0
    unsupported = 0
    for paragraph in re.split(r"\n{2,}", str(answer or "")):
        for sentence in _web_sentences(paragraph):
            ids = _CITATION.findall(sentence)
            if not ids:
                continue
            cited_sentences += 1
            if not any(
                source_id in web_items
                and _web_sentence_supports(sentence, web_items[source_id])
                for source_id in ids
            ):
                unsupported += 1
    if not cited_sentences:
        return QualityCheck("web_evidence_support", "skipped", "no_cited_sections")
    if unsupported:
        return QualityCheck(
            "web_evidence_support", "failed", "web_claim_not_supported",
            observations=(("unsupported_claim_count", unsupported),),
        )
    return QualityCheck(
        "web_evidence_support", "passed", "provider_cited_grounding",
        observations=(("cited_claim_count", cited_sentences),),
    )


def optional_model_claim_check(
    *,
    answer: str,
    evidence_pack: EvidencePack,
    verifier: Callable[[str, EvidencePack], bool] | None,
) -> QualityCheck:
    if verifier is None:
        return QualityCheck("model_claim_verifier", "skipped", "disabled")
    try:
        passed = bool(verifier(answer, evidence_pack))
    except GenerationCancelled:
        raise
    except Exception:
        return QualityCheck("model_claim_verifier", "error", "verifier_unavailable")
    return QualityCheck(
        "model_claim_verifier",
        "passed" if passed else "failed",
        "" if passed else "claim_verifier_rejected",
    )
