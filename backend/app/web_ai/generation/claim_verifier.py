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
