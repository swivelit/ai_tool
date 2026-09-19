#!/usr/bin/env python3
"""Publish the reviewed video legal draft only after an explicit owner attestation.

This is a local, operator-invoked helper. It never contacts a provider, deploys
anything, sends mail or changes a database. The default is a non-mutating
dry-run; publication requires explicit confirmations and writes a private
backup before replacing the two local publication records.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import secrets
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "web" / "src" / "content" / "legalContent.json"
DRAFT = ROOT / "web" / "src" / "content" / "videoLegalDraft.json"
ATTESTATION = ROOT / "docs" / "OWNER_LEGAL_PUBLICATION_ATTESTATION.md"
BACKUPS = ROOT / ".swico-legal-publication-backups"
ROLE_RE = re.compile(r"^[^\x00-\x1f\x7f]{3,160}$")
PLACEHOLDERS = {"name", "role", "owner", "real role", "tbd", "todo", "placeholder", "unknown"}
REQUIRED_CONFIRMATIONS = ("confirm_authority", "confirm_not_counsel_reviewed", "confirm_right_to_publish")


def load_checker():
    path = ROOT / "scripts" / "check-legal-publication.py"
    spec = importlib.util.spec_from_file_location("swico_legal_publication_checker", path)
    if not spec or not spec.loader:
        raise RuntimeError("cannot load legal publication checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read {path.name}: {type(exc).__name__}") from None
    if not isinstance(value, dict):
        raise SystemExit(f"{path.name} must contain an object")
    return value


def validate_inputs(args: argparse.Namespace) -> tuple[str, str]:
    role = args.approver_role.strip()
    approved_date = args.approval_date.strip()
    if not ROLE_RE.fullmatch(role) or role.casefold() in PLACEHOLDERS:
        raise SystemExit("--approver-role must be a real accountable owner role or name; placeholders are refused")
    try:
        if date.fromisoformat(approved_date).isoformat() != approved_date:
            raise ValueError
    except ValueError:
        raise SystemExit("--approval-date must be a real YYYY-MM-DD date") from None
    return role, approved_date


def build_candidate(current: dict, draft: dict, checker, role: str, approved_date: str, reference: str) -> tuple[dict, str]:
    if not isinstance(draft.get("pages"), dict) or set(draft["pages"]) != checker.REQUIRED_PAGES:
        raise SystemExit("video legal draft must contain exactly the required policy pages")
    current_publication = current.get("publication") if isinstance(current.get("publication"), dict) else {}
    draft_publication = draft.get("publication") if isinstance(draft.get("publication"), dict) else {}
    for key in ("businessIdentity", "supportEmail", "billingSupportEmail", "privacyEmail"):
        if draft_publication.get(key) != current_publication.get(key):
            raise SystemExit(f"video draft cannot change canonical publication field: {key}")

    candidate = copy.deepcopy(current)
    candidate["pages"] = copy.deepcopy(draft["pages"])
    candidate["publication"] = copy.deepcopy(current_publication)
    candidate["publication"]["publicationStatus"] = "owner_approved"
    candidate["publication"]["approval"] = {
        "approvalType": "owner_attestation",
        "approvedByNameOrRole": role,
        "writtenAttestationReference": reference,
        "approvalDate": approved_date,
        "legalReviewStatus": "not_reviewed_by_counsel",
        "approvedLegalContentSha256": checker.legal_content_fingerprint(candidate),
    }
    return candidate, candidate["publication"]["approval"]["approvedLegalContentSha256"]


def attestation_text(role: str, approved_date: str, reference: str, fingerprint: str) -> str:
    return f"""# Owner Legal Publication Attestation

This private record is an owner/business publication attestation. It is not
legal advice, a counsel opinion, or evidence of a third-party model, movie,
performer, face, music or template licence.

- Attestation reference: {reference}
- Attestation date: {approved_date}
- Accountable owner or role: {role}
- Approved legal-content SHA-256: {fingerprint}
- Not reviewed or approved by legal counsel

The accountable owner confirms that they have authority to publish the exact
policy pages whose SHA-256 is recorded above, and that the business identity,
support contacts, pricing, delivery, privacy, acceptable-use and synthetic
media disclosure statements were checked against the current product. This
confirmation does not approve or prove any third-party model, movie,
performer, source-face, audio or music rights. Those rights remain separate
operator evidence and release gates.

The owner also confirms that the publication is not a representation that
counsel reviewed it and that any legal or regulatory obligation requiring
professional review remains an external release prerequisite.
"""


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def backup(path: Path, stamp: str) -> Path:
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(BACKUPS, 0o700)
    destination = BACKUPS / f"{path.name}.{stamp}.{secrets.token_hex(4)}.bak"
    destination.write_bytes(path.read_bytes())
    os.chmod(destination, 0o600)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="owner-attested local video legal publication helper")
    parser.add_argument("--owner-attestation", action="store_true", help="confirm this is an explicit accountable-owner attestation")
    parser.add_argument("--approver-role", required=True)
    parser.add_argument("--approval-date", required=True)
    parser.add_argument("--confirm-authority", action="store_true")
    parser.add_argument("--confirm-not-counsel-reviewed", action="store_true")
    parser.add_argument("--confirm-right-to-publish", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="validate and show fingerprints without modifying files")
    args = parser.parse_args()
    if not args.owner_attestation:
        raise SystemExit("refusing publication without --owner-attestation")
    role, approved_date = validate_inputs(args)
    if not args.dry_run and not all(getattr(args, name) for name in REQUIRED_CONFIRMATIONS):
        raise SystemExit("publication requires --confirm-authority, --confirm-not-counsel-reviewed and --confirm-right-to-publish")

    current = read_json(CONTENT)
    draft = read_json(DRAFT)
    checker = load_checker()
    old_fingerprint = checker.legal_content_fingerprint(current)
    reference = "SWICO-OWNER-VIDEO-PUBLICATION-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(4)
    candidate, fingerprint = build_candidate(current, draft, checker, role, approved_date, reference)
    attestation = attestation_text(role, approved_date, reference, fingerprint).encode("utf-8")
    candidate_bytes = (json.dumps(candidate, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with tempfile.TemporaryDirectory(prefix="swico-legal-check-") as directory:
        content_path = Path(directory) / "legalContent.json"
        attestation_path = Path(directory) / "OWNER_LEGAL_PUBLICATION_ATTESTATION.md"
        content_path.write_bytes(candidate_bytes)
        attestation_path.write_bytes(attestation)
        findings = checker.findings(content_path=content_path, app_path=ROOT / "web" / "src" / "App.tsx", owner_attestation_path=attestation_path)
    if findings:
        for finding in findings:
            print(f"publication blocker: {finding}")
        raise SystemExit(f"refusing publication: {len(findings)} legal checker blocker(s)")

    print(json.dumps({"dry_run": args.dry_run, "old_sha256": old_fingerprint, "proposed_sha256": fingerprint,
                      "attestation_reference": reference, "pages": sorted(checker.REQUIRED_PAGES),
                      "message": "no files changed" if args.dry_run else "candidate validated; publication requires the listed confirmations"}, indent=2))
    if args.dry_run:
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    original_content = CONTENT.read_bytes()
    original_attestation = ATTESTATION.read_bytes() if ATTESTATION.exists() else None
    backup(CONTENT, stamp)
    if ATTESTATION.exists():
        backup(ATTESTATION, stamp)
    try:
        atomic_write(CONTENT, candidate_bytes)
        atomic_write(ATTESTATION, attestation)
    except Exception:
        atomic_write(CONTENT, original_content)
        if original_attestation is None:
            try:
                ATTESTATION.unlink()
            except FileNotFoundError:
                pass
        else:
            atomic_write(ATTESTATION, original_attestation)
        raise
    print(f"published owner-attested local legal content; private backups: {BACKUPS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
