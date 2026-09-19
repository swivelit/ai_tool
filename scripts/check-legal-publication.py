#!/usr/bin/env python3
"""Validate complete legal publication content and explicit approval metadata."""

from __future__ import annotations

import json
import hashlib
import re
from datetime import date
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "web" / "src" / "content" / "legalContent.json"
APP = ROOT / "web" / "src" / "App.tsx"
OWNER_ATTESTATION = ROOT / "docs" / "OWNER_LEGAL_PUBLICATION_ATTESTATION.md"
REQUIRED_PAGES = {"terms", "privacy", "refunds", "contact", "ai", "delivery", "pricing"}
EMAIL_RE = re.compile(r"^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$", re.IGNORECASE)
DOMAIN_ONLY_RE = re.compile(r"^(?:https?://)?(?:www\.)?[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+(?:/)?$", re.IGNORECASE)
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
APPROVAL_PLACEHOLDERS = {"fake", "nil", "none", "placeholder", "tbd", "todo", "unknown"}

# Marker patterns are deliberately specific. Ordinary lowercase prose such as
# "a draft was discussed" or "the owner can contact support" is not blocked.
MARKERS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("template brackets [[ or ]]", re.compile(r"\[\[|\]\]")),
    ("COMPLETE placeholder", re.compile(r"\[\[\s*COMPLETE\s*\]\]", re.IGNORECASE)),
    ("PASTE EXACT APPROVED instruction", re.compile(r"\bPASTE\s+EXACT\s+APPROVED\b", re.IGNORECASE)),
    ("DRAFT_NOT_APPROVED marker", re.compile(r"(?<![A-Z0-9_])DRAFT_NOT_APPROVED(?![A-Z0-9_])")),
    ("NOT APPROVED marker", re.compile(r"(?<![A-Z0-9_])NOT APPROVED(?![A-Z0-9_])")),
    ("DRAFT marker", re.compile(r"(?<![A-Z0-9_])DRAFT(?![A-Z0-9_])")),
    ("TODO marker", re.compile(r"(?<![A-Z0-9_])TODO(?![A-Z0-9_])")),
    ("COUNSEL drafting label", re.compile(r"(?<![A-Z0-9_])COUNSEL\s*:")),
    ("OWNER drafting label", re.compile(r"(?<![A-Z0-9_])OWNER\s*:")),
    ("ACCOUNTANT drafting label", re.compile(r"(?<![A-Z0-9_])ACCOUNTANT\s*:")),
)


def _strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _strings(child)


def _value(mapping: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if value is not None:
            return str(value).strip()
    return ""


def _email_findings(label: str, value: str) -> list[str]:
    if not value:
        return [f"{label} is missing"]
    if value.casefold() == "nil":
        return [f"{label} must not be Nil"]
    if DOMAIN_ONLY_RE.fullmatch(value):
        return [f"{label} contains only a domain"]
    if not EMAIL_RE.fullmatch(value):
        return [f"{label} is not a valid email address"]
    return []


def _is_meaningful_approval_value(value: str) -> bool:
    return bool(value) and value.casefold() not in APPROVAL_PLACEHOLDERS


def _is_iso_date(value: str) -> bool:
    if not ISO_DATE_RE.fullmatch(value):
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def legal_content_fingerprint(data: dict[str, Any]) -> str:
    """Hash the canonical publishable policy pages, excluding approval metadata."""
    pages = data.get("pages") if isinstance(data.get("pages"), dict) else {}
    canonical = json.dumps(
        pages, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _approval_findings(publication: dict[str, Any], content_fingerprint: str, owner_attestation_path: Path | None = None) -> list[str]:
    status = _value(publication, "publicationStatus")
    approval = publication.get("approval") if isinstance(publication.get("approval"), dict) else {}
    approval_type = _value(approval, "approvalType")
    errors: list[str] = []

    if status == "owner_approved":
        if approval_type != "owner_attestation":
            errors.append("owner-approved publication requires approvalType=owner_attestation")

        approver = _value(approval, "approvedByNameOrRole")
        reference = _value(approval, "writtenAttestationReference")
        approval_date = _value(approval, "approvalDate")
        if not _is_meaningful_approval_value(approver):
            errors.append("owner-attested publication is missing a valid approvedByNameOrRole")
        if not _is_meaningful_approval_value(reference):
            errors.append("owner-attested publication is missing a valid writtenAttestationReference")
        if not approval_date:
            errors.append("owner-attested publication is missing approvalDate")
        elif not _is_iso_date(approval_date):
            errors.append("owner-attested publication approvalDate must use valid YYYY-MM-DD format")
        if _value(approval, "legalReviewStatus") != "not_reviewed_by_counsel":
            errors.append("owner-attested publication requires legalReviewStatus=not_reviewed_by_counsel")
        approved_fingerprint = _value(approval, "approvedLegalContentSha256")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", approved_fingerprint):
            errors.append("owner-approved publication requires a valid approvedLegalContentSha256")
        elif approved_fingerprint.casefold() != content_fingerprint:
            errors.append("approved legal-content SHA-256 does not match current publishable content")

        try:
            attestation = (owner_attestation_path or OWNER_ATTESTATION).read_text(encoding="utf-8")
        except OSError:
            errors.append("owner-attested publication requires docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md")
        else:
            if reference and f"Attestation reference: {reference}" not in attestation:
                errors.append("owner-attestation document reference does not match publication metadata")
            if approval_date and f"Attestation date: {approval_date}" not in attestation:
                errors.append("owner-attestation document date does not match publication metadata")
            if "Not reviewed or approved by legal counsel" not in attestation:
                errors.append("owner-attestation document must state that counsel did not review or approve it")
            if approved_fingerprint and f"Approved legal-content SHA-256: {approved_fingerprint}" not in attestation:
                errors.append("owner-attestation document fingerprint does not match publication metadata")

    elif status == "approved_by_counsel":
        if approval_type != "counsel_approval":
            errors.append("counsel-approved publication requires approvalType=counsel_approval")
        if not _is_meaningful_approval_value(_value(approval, "counselNameOrFirm")):
            errors.append("counsel-approved publication is missing a valid counselNameOrFirm")
        if not _is_meaningful_approval_value(_value(approval, "writtenApprovalReference")):
            errors.append("counsel-approved publication is missing a valid writtenApprovalReference")
        approval_date = _value(approval, "approvalDate")
        if not approval_date:
            errors.append("counsel-approved publication is missing approvalDate")
        elif not _is_iso_date(approval_date):
            errors.append("counsel-approved publication approvalDate must use valid YYYY-MM-DD format")
        approved_fingerprint = _value(approval, "approvedLegalContentSha256")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", approved_fingerprint):
            errors.append("counsel-approved publication requires a valid approvedLegalContentSha256")
        elif approved_fingerprint.casefold() != content_fingerprint:
            errors.append("approved legal-content SHA-256 does not match current publishable content")

    elif status == "approved":
        errors.append("publicationStatus=approved is ambiguous; use owner_approved or approved_by_counsel")
    elif status == "unreviewed":
        errors.append("publicationStatus=unreviewed is not publishable")
    else:
        errors.append("publicationStatus must be owner_approved or approved_by_counsel")

    return errors


def _stale_pricing_findings(data: dict[str, Any], owner_attestation_path: Path | None = None) -> list[str]:
    pages = data.get("pages") if isinstance(data.get("pages"), dict) else {}
    errors: list[str] = []
    terms_text = "\n".join(_strings(pages.get("terms", {})))
    if "Available top-up packages are ordinarily Rs.10, Rs.50, Rs.100 and Rs.500" in terms_text:
        errors.append(
            "terms: approved package description still lists Rs.10, Rs.50, Rs.100 and Rs.500; "
            "exact owner/counsel-approved replacement wording is required"
        )
    pricing = pages.get("pricing") if isinstance(pages.get("pricing"), dict) else {}
    gross_sections = [
        section for section in pricing.get("sections", [])
        if isinstance(section, dict) and _value(section, "heading") == "Gross top-up price"
    ]
    if any(
        "Rs.10, Rs.50, Rs.100 and Rs.500" in _value(section, "body")
        or "Rs.50 provides Rs.25" in _value(section, "body")
        for section in gross_sections
    ):
        errors.append(
            "pricing: approved Gross top-up price section still describes the removed Rs.50, "
            "Rs.100 and Rs.500 package set; exact owner/counsel-approved replacement wording is required"
        )
    try:
        attestation = (owner_attestation_path or OWNER_ATTESTATION).read_text(encoding="utf-8")
    except OSError:
        attestation = ""
    if "the ₹10, ₹50, ₹100 and ₹500 packages match the actual product" in attestation:
        errors.append(
            "owner attestation: approved package statement still lists ₹10, ₹50, ₹100 and ₹500; "
            "a new matching owner/counsel approval record is required"
        )
    return errors


def findings(*, content_path: Path | None = None, app_path: Path | None = None,
             owner_attestation_path: Path | None = None) -> list[str]:
    content_path = content_path or CONTENT
    app_path = app_path or APP
    owner_attestation_path = owner_attestation_path or OWNER_ATTESTATION
    try:
        data = json.loads(content_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"legal content cannot be read as JSON: {type(exc).__name__}"]

    publication = data.get("publication") if isinstance(data.get("publication"), dict) else {}
    pages = data.get("pages") if isinstance(data.get("pages"), dict) else {}
    errors: list[str] = []

    if not _value(publication, "businessIdentity"):
        errors.append("missing business identity")
    errors.extend(_approval_findings(publication, legal_content_fingerprint(data), owner_attestation_path))
    errors.extend(_stale_pricing_findings(data, owner_attestation_path))

    errors.extend(_email_findings("support email", _value(publication, "supportEmail", "supportContact")))
    errors.extend(_email_findings("billing-support email", _value(publication, "billingSupportEmail")))
    errors.extend(_email_findings("privacy email", _value(publication, "privacyEmail")))

    for marker, pattern in MARKERS:
        if any(pattern.search(value) for value in _strings(publication)):
            errors.append(f"publication metadata contains {marker}")

    for page in sorted(REQUIRED_PAGES - set(pages)):
        errors.append(f"missing required page: {page}")

    for slug in sorted(REQUIRED_PAGES & set(pages)):
        page = pages[slug]
        if not isinstance(page, dict):
            errors.append(f"{slug}: missing policy body")
            continue
        if not _value(page, "effectiveDate"):
            errors.append(f"{slug}: missing effective date")
        version = _value(page, "version")
        if not version or version.casefold() == "draft":
            errors.append(f"{slug}: missing published version")

        sections = page.get("sections")
        if not isinstance(sections, list) or not sections:
            errors.append(f"{slug}: missing policy body")
        else:
            nonempty_bodies = 0
            for index, section in enumerate(sections, start=1):
                if not isinstance(section, dict):
                    errors.append(f"{slug}: empty section {index}")
                    continue
                body = _value(section, "body")
                if body:
                    nonempty_bodies += 1
                else:
                    heading = _value(section, "heading") or str(index)
                    errors.append(f"{slug}: empty section: {heading}")
            if nonempty_bodies == 0:
                errors.append(f"{slug}: missing policy body")

        for marker, pattern in MARKERS:
            if any(pattern.search(value) for value in _strings(page)):
                errors.append(f"{slug}: contains {marker}")

    try:
        app_source = app_path.read_text(encoding="utf-8")
    except OSError:
        errors.append("missing canonical /pricing route")
    else:
        if not re.search(r"<Route\s+path=[\"']/pricing[\"']", app_source):
            errors.append("missing canonical /pricing route")

    # Stable ordering with no duplicate output makes the report actionable.
    return list(dict.fromkeys(errors))


def main() -> int:
    errors = findings()
    if errors:
        for error in errors:
            print(f"legal publication blocker: {error}")
        print(f"legal publication check failed: {len(errors)} blocker(s)")
        return 1
    data = json.loads(CONTENT.read_text(encoding="utf-8"))
    if data["publication"]["publicationStatus"] == "owner_approved":
        print("legal publication check passed (owner-attested publication; no counsel approval or legal advice inferred)")
    else:
        print("legal publication check passed (counsel approval metadata recorded; retain private evidence separately)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
