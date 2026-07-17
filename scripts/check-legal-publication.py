#!/usr/bin/env python3
"""Validate that every public policy has approved, complete publication data."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "web" / "src" / "content" / "legalContent.json"
REQUIRED_PAGES = {"terms", "privacy", "refunds", "contact", "ai", "delivery", "pricing"}
FORBIDDEN = ("todo", "placeholder", "pending legal review")


def findings() -> list[str]:
    data = json.loads(CONTENT.read_text(encoding="utf-8"))
    publication = data.get("publication") or {}
    pages = data.get("pages") or {}
    errors: list[str] = []
    if not str(publication.get("businessIdentity") or "").strip():
        errors.append("missing business identity")
    if not str(publication.get("supportContact") or "").strip():
        errors.append("missing support contact")
    if publication.get("publicationStatus") != "approved":
        errors.append("publication status is not approved")
    for page in sorted(REQUIRED_PAGES - set(pages)):
        errors.append(f"missing required page: {page}")
    for slug in sorted(REQUIRED_PAGES & set(pages)):
        page = pages[slug]
        if not str(page.get("effectiveDate") or "").strip():
            errors.append(f"{slug}: missing effective date")
        if not str(page.get("version") or "").strip() or page.get("version") == "draft":
            errors.append(f"{slug}: missing published version")
        sections = page.get("sections") or []
        if not sections or any(not str(item.get("body") or "").strip() for item in sections):
            errors.append(f"{slug}: missing reviewed section content")
        serialized = json.dumps(page, ensure_ascii=False).lower()
        for phrase in FORBIDDEN:
            if phrase in serialized:
                errors.append(f"{slug}: contains forbidden publication marker: {phrase}")
    return errors


def main() -> int:
    errors = findings()
    if errors:
        for error in errors:
            print(f"legal publication blocker: {error}")
        print(f"legal publication check failed: {len(errors)} blocker(s)")
        return 1
    print("legal publication check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
