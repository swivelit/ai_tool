#!/usr/bin/env python3
"""Block public legal launch until exact approved publication data is complete."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "web" / "src" / "content" / "legalContent.json"
APP = ROOT / "web" / "src" / "App.tsx"
REQUIRED_PAGES = {"terms", "privacy", "refunds", "contact", "ai", "delivery", "pricing"}
EMAIL_RE = re.compile(r"^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$", re.IGNORECASE)
DOMAIN_ONLY_RE = re.compile(r"^(?:https?://)?(?:www\.)?[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+(?:/)?$", re.IGNORECASE)

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


def findings() -> list[str]:
    try:
        data = json.loads(CONTENT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"legal content cannot be read as JSON: {type(exc).__name__}"]

    publication = data.get("publication") if isinstance(data.get("publication"), dict) else {}
    pages = data.get("pages") if isinstance(data.get("pages"), dict) else {}
    errors: list[str] = []

    if not _value(publication, "businessIdentity"):
        errors.append("missing business identity")
    if publication.get("publicationStatus") != "approved":
        errors.append("publicationStatus is not approved")

    errors.extend(_email_findings("support email", _value(publication, "supportEmail", "supportContact")))
    errors.extend(_email_findings("billing-support email", _value(publication, "billingSupportEmail")))
    errors.extend(_email_findings("privacy email", _value(publication, "privacyEmail")))

    approval = publication.get("approval") if isinstance(publication.get("approval"), dict) else {}
    missing_approval: list[str] = []
    if not _value(approval, "counselNameOrFirm", "counselName", "counselFirm"):
        missing_approval.append("counsel name or firm")
    if not _value(approval, "writtenApprovalReference", "approvalReference"):
        missing_approval.append("written approval reference")
    if not _value(approval, "approvalDate"):
        missing_approval.append("approval date")
    if missing_approval:
        errors.append("incomplete approval metadata")
        errors.extend(f"missing {field}" for field in missing_approval)

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
        app_source = APP.read_text(encoding="utf-8")
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
    print("legal publication check passed (repository structure only; retain approval evidence separately)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
