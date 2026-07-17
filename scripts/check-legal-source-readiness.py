#!/usr/bin/env python3
"""Inspect a private legal handoff locally for structural publication blockers.

The script never uploads or changes source files and emits only fixed category
and blocker descriptions. A passing result is structural readiness, not legal
approval.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional
from xml.etree import ElementTree


SUPPORTED_SUFFIXES = {".pdf", ".md", ".txt", ".docx"}
EMAIL_RE = re.compile(r"^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$", re.IGNORECASE)
DOMAIN_ONLY_RE = re.compile(r"^(?:https?://)?(?:www\.)?[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+(?:/)?$", re.IGNORECASE)
ISO_DATE_RE = re.compile(r"\b20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b")
INCOMPLETE_RE = re.compile(
    r"\[\[|\]\]|\b(?:TBD|TBC|TODO|Nil|N/A|unresolved|unknown|missing|pending|not supplied|not provided|not (?:yet )?(?:finali[sz]ed|confirmed|decided)|to be (?:confirmed|decided|completed))\b",
    re.IGNORECASE,
)

MARKERS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("template brackets ([[ or ]]) remain", re.compile(r"\[\[|\]\]")),
    ("a COMPLETE placeholder remains", re.compile(r"\[\[\s*COMPLETE\s*\]\]", re.IGNORECASE)),
    ("a PASTE EXACT APPROVED drafting instruction remains", re.compile(r"\bPASTE\s+EXACT\s+APPROVED\b", re.IGNORECASE)),
    ("a DRAFT_NOT_APPROVED marker remains", re.compile(r"(?<![A-Z0-9_])DRAFT_NOT_APPROVED(?![A-Z0-9_])")),
    ("a NOT APPROVED marker remains", re.compile(r"(?<![A-Z0-9_])NOT APPROVED(?![A-Z0-9_])")),
    ("a DRAFT marker remains", re.compile(r"(?<![A-Z0-9_])DRAFT(?![A-Z0-9_])")),
    ("a TODO marker remains", re.compile(r"(?<![A-Z0-9_])TODO(?![A-Z0-9_])")),
    ("a COUNSEL drafting label remains", re.compile(r"(?<![A-Z0-9_])COUNSEL\s*:")),
    ("an OWNER drafting label remains", re.compile(r"(?<![A-Z0-9_])OWNER\s*:")),
    ("an ACCOUNTANT drafting label remains", re.compile(r"(?<![A-Z0-9_])ACCOUNTANT\s*:")),
)


@dataclass(frozen=True)
class Policy:
    key: str
    name: str
    heading: re.Pattern[str]


POLICIES = (
    Policy("terms", "Terms and Conditions", re.compile(r"\bTerms\s+and\s+Conditions\b", re.IGNORECASE)),
    Policy("privacy", "Privacy Policy", re.compile(r"\bPrivacy\s+Policy\b", re.IGNORECASE)),
    Policy("refunds", "Cancellation and Refund Policy", re.compile(r"\b(?:Cancellation\s+and\s+Refund|Refund\s+and\s+Cancellation)\s+Policy\b", re.IGNORECASE)),
    Policy("contact", "Contact and Support", re.compile(r"\bContact\s+(?:and|&)\s+Support\b", re.IGNORECASE)),
    Policy("ai", "AI Use and Limitations Policy", re.compile(r"\bAI(?:\s+Use\s+and)?\s+Limitations(?:\s+Policy)?\b", re.IGNORECASE)),
    Policy("delivery", "Digital Service Delivery / Shipping Policy", re.compile(r"\bDigital\s+Service\s+Delivery(?:\s*/\s*Shipping)?(?:\s+Policy)?\b", re.IGNORECASE)),
    Policy("pricing", "Pricing and Token Credits", re.compile(r"\bPricing\s+(?:and|&)\s+(?:Token\s+Credits|Top[- ]?up\s+Information)\b|\bPricing/Top[- ]?up\s+Disclosure\b", re.IGNORECASE)),
)

UNRESOLVED_TOPICS: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("Privacy", "retention periods are unresolved", re.compile(r"\bretention\b", re.IGNORECASE)),
    ("Privacy", "the deletion process is unresolved", re.compile(r"\bdeletion\b", re.IGNORECASE)),
    ("Refunds", "the refund window is unresolved", re.compile(r"\b(?:refund|cancellation)\b[^\n]{0,50}\b(?:window|period|deadline|days?|timeline)\b|\b(?:window|period|deadline|timeline)\b[^\n]{0,50}\brefund\b", re.IGNORECASE)),
    ("Refunds", "refund eligibility or exclusions are unresolved", re.compile(r"\brefund\s+(?:eligibility|exclusions?)\b", re.IGNORECASE)),
    ("Refunds", "consumed-credit treatment is unresolved", re.compile(r"\bconsumed[- ]credit\s+treatment\b", re.IGNORECASE)),
    ("Refunds", "50% allocation refund treatment is unresolved", re.compile(r"\b50%\s+allocation\s+refund\s+treatment\b", re.IGNORECASE)),
)


class SourceReadError(Exception):
    """A source could not be read without exposing its contents."""


def _extract_docx(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("word/document.xml")
    except (OSError, KeyError, zipfile.BadZipFile) as exc:
        raise SourceReadError from exc
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as exc:
        raise SourceReadError from exc
    output: list[str] = []
    for node in root.iter():
        if node.tag.endswith("}t") and node.text:
            output.append(node.text)
        elif node.tag.endswith("}p"):
            output.append("\n")
        elif node.tag.endswith("}tab"):
            output.append("\t")
    return "".join(output)


def _extract_pdf_library(path: Path) -> Optional[str]:
    for module_name in ("pypdf", "PyPDF2"):
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        try:
            reader = module.PdfReader(str(path))
            return "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception as exc:  # Third-party PDF parsers expose varied errors.
            raise SourceReadError from exc
    return None


def _extract_pdf(path: Path, module_cache: Path) -> str:
    library_text = _extract_pdf_library(path)
    if library_text is not None:
        return library_text

    pdftotext = shutil.which("pdftotext")
    if pdftotext:
        try:
            result = subprocess.run(
                [pdftotext, str(path), "-"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=60,
            )
            return result.stdout
        except (OSError, subprocess.SubprocessError) as exc:
            raise SourceReadError from exc

    # macOS includes PDFKit. This fallback extracts embedded text only and does
    # not invoke OCR, network access, or write beside the source document.
    swift = shutil.which("swift")
    if swift and sys.platform == "darwin":
        program = (
            "import Foundation; import PDFKit; "
            "let u=URL(fileURLWithPath:CommandLine.arguments[1]); "
            "guard let d=PDFDocument(url:u) else { exit(2) }; "
            "for i in 0..<d.pageCount { if let s=d.page(at:i)?.string { print(s) } }"
        )
        try:
            result = subprocess.run(
                [swift, "-module-cache-path", str(module_cache), "-e", program, str(path)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=60,
            )
            return result.stdout
        except (OSError, subprocess.SubprocessError) as exc:
            raise SourceReadError from exc

    raise SourceReadError


def _read_source(path: Path, module_cache: Path) -> str:
    suffix = path.suffix.casefold()
    if suffix in {".md", ".txt"}:
        try:
            return path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise SourceReadError from exc
    if suffix == ".docx":
        return _extract_docx(path)
    if suffix == ".pdf":
        return _extract_pdf(path, module_cache)
    raise SourceReadError


def _normalized_hash(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text).strip().casefold()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def read_documents(source_dir: Path) -> tuple[list[str], list[str]]:
    read_errors: list[str] = []
    documents: list[str] = []
    seen: set[str] = set()
    if not source_dir.is_dir():
        return [], ["source directory does not exist"]
    paths = sorted(path for path in source_dir.rglob("*") if path.is_file() and path.suffix.casefold() in SUPPORTED_SUFFIXES)
    if not paths:
        return [], ["no supported PDF, Markdown, TXT, or DOCX source files were found"]
    with tempfile.TemporaryDirectory(prefix="swico-legal-readiness-") as cache:
        cache_path = Path(cache)
        for path in paths:
            try:
                text = _read_source(path, cache_path)
            except SourceReadError:
                read_errors.append("one or more supported source files could not be read")
                continue
            if not text.strip():
                read_errors.append("one or more supported source files contain no extractable text")
                continue
            digest = _normalized_hash(text)
            if digest not in seen:
                seen.add(digest)
                documents.append(text)
    return documents, list(dict.fromkeys(read_errors))


def _all_heading_matches(text: str) -> list[tuple[int, int, Policy]]:
    matches: list[tuple[int, int, Policy]] = []
    for policy in POLICIES:
        matches.extend((match.start(), match.end(), policy) for match in policy.heading.finditer(text))
    return sorted(matches, key=lambda item: (item[0], item[1]))


def _segments(text: str, target: Policy) -> list[str]:
    headings = _all_heading_matches(text)
    segments: list[str] = []
    for index, (start, _end, policy) in enumerate(headings):
        if policy.key != target.key:
            continue
        next_start = headings[index + 1][0] if index + 1 < len(headings) else len(text)
        segments.append(text[start:next_start])
    return segments


def _contains_marker(text: str) -> bool:
    return any(pattern.search(text) for _description, pattern in MARKERS) or bool(INCOMPLETE_RE.search(text))


def _looks_like_complete_body(segment: str) -> bool:
    if _contains_marker(segment):
        return False
    words = re.findall(r"\b[\w'-]+\b", segment, re.UNICODE)
    statements = len(re.findall(r"[.!;](?:\s|$)", segment))
    questions = segment.count("?")
    questionnaire_markers = len(re.findall(r"(?im)^\s*(?:question|answer|response|complete)\s*[:|-]", segment))
    return len(words) >= 80 and len(segment) >= 500 and statements >= 4 and questions <= 2 and questionnaire_markers == 0


def _has_effective_date(segment: str) -> bool:
    for line in segment.splitlines():
        if re.search(r"\beffective\s+date\b", line, re.IGNORECASE) and ISO_DATE_RE.search(line) and not _contains_marker(line):
            return True
    return False


def _has_version(segment: str) -> bool:
    for line in segment.splitlines():
        match = re.search(r"\bversion\b\s*[:|=-]?\s*(.+)$", line, re.IGNORECASE)
        if match and match.group(1).strip() and not _contains_marker(match.group(1)) and match.group(1).strip().casefold() != "draft":
            return True
    return False


def _field_values(text: str, label: re.Pattern[str]) -> list[str]:
    lines = [line.strip() for line in text.splitlines()]
    values: list[str] = []
    for index, line in enumerate(lines):
        match = label.search(line)
        if not match:
            continue
        remainder = re.sub(r"^\s*\([^)]*\)\s*", "", line[match.end():]).strip(" \t:|=-")
        if remainder:
            values.append(remainder)
            continue
        for following in lines[index + 1:index + 3]:
            if following:
                values.append(following)
                break
    return values


def _resolved_value(values: Iterable[str]) -> bool:
    field_label = re.compile(
        r"^(?:counsel(?:\s+name|\s+firm|\s+name\s*/\s*firm)?|written\s+approval\s+reference|approval\s+(?:reference|date|status))\s*:?$",
        re.IGNORECASE,
    )
    return any(
        len(value.strip()) >= 3
        and not INCOMPLETE_RE.search(value)
        and not field_label.fullmatch(value.strip())
        for value in values
    )


def _resolved_approval_reference(values: Iterable[str]) -> bool:
    return any(
        len(value.strip()) >= 6
        and not INCOMPLETE_RE.search(value)
        and bool(re.search(r"[\d/#_.@-]", value))
        for value in values
    )


def _email_blocker(label: str, values: list[str]) -> Optional[str]:
    if not values:
        return f"{label} is missing"
    for raw in values:
        value = re.sub(r"^\s*\([^)]*\)\s*", "", raw).strip(" \t:|=-")
        if value.casefold() == "nil":
            return f"{label} must not be Nil"
        if DOMAIN_ONLY_RE.fullmatch(value):
            return f"{label} contains only a domain rather than an email address"
        if EMAIL_RE.fullmatch(value):
            return None
    return f"{label} is not a valid email address"


def _topic_is_explicitly_unresolved(text: str, topic: re.Pattern[str]) -> bool:
    for line in text.splitlines():
        match = topic.search(line)
        if not match:
            continue
        remainder = line[match.end():].strip(" \t:|=-")
        if INCOMPLETE_RE.search(line) or not remainder:
            return True
    return False


def analyze_documents(documents: list[str], read_errors: Optional[list[str]] = None) -> list[tuple[str, str]]:
    findings: list[tuple[str, str]] = []

    def add(category: str, description: str) -> None:
        item = (category, description)
        if item not in findings:
            findings.append(item)

    for error in read_errors or []:
        add("Source material", error)
    if not documents:
        add("Source material", "no readable source content is available")
        return findings

    combined = "\n\n".join(documents)
    for description, pattern in MARKERS:
        if pattern.search(combined):
            add("Drafting markers", description)

    for policy in POLICIES:
        policy_segments = [segment for document in documents for segment in _segments(document, policy)]
        complete = [segment for segment in policy_segments if _looks_like_complete_body(segment)]
        if not complete:
            add("Policy bodies", f"{policy.name}: complete exact policy body not found")
        if not any(_has_effective_date(segment) for segment in policy_segments):
            add("Publication metadata", f"{policy.name}: effective date is missing")
        if not any(_has_version(segment) for segment in policy_segments):
            add("Publication metadata", f"{policy.name}: published version is missing")

    email_fields = (
        ("support email", re.compile(r"\b(?:public\s+)?support\s+(?:email|contact)\b", re.IGNORECASE)),
        ("billing-support email", re.compile(r"\bbilling[- ]support\s+(?:email|contact)\b", re.IGNORECASE)),
        ("privacy email", re.compile(r"\bprivacy\b[^\n]{0,60}\b(?:email|contact)\b|\b(?:email|contact)\b[^\n]{0,60}\bprivacy\b", re.IGNORECASE)),
    )
    for label, pattern in email_fields:
        blocker = _email_blocker(label, _field_values(combined, pattern))
        if blocker:
            add("Business/contact", blocker)

    counsel_values = _field_values(combined, re.compile(r"\bcounsel\s+(?:name|firm|name\s*/\s*firm)\b", re.IGNORECASE))
    if not _resolved_value(counsel_values):
        add("Sign-off", "counsel name or firm is missing")
    approval_reference_values = _field_values(combined, re.compile(r"\b(?:written\s+)?approval\s+reference\b", re.IGNORECASE))
    if not _resolved_approval_reference(approval_reference_values):
        add("Sign-off", "written approval reference is missing")
    approval_dates = _field_values(combined, re.compile(r"\bapproval\s+date\b", re.IGNORECASE))
    if not any(ISO_DATE_RE.search(value) and not INCOMPLETE_RE.search(value) for value in approval_dates):
        add("Sign-off", "approval date is missing")

    approval_status = _field_values(combined, re.compile(r"\bapproval\s+status\b", re.IGNORECASE))
    if not any(value.strip().casefold() == "approved" for value in approval_status):
        add("Sign-off", "approval status is not complete")

    for category, description, topic in UNRESOLVED_TOPICS:
        if _topic_is_explicitly_unresolved(combined, topic):
            add(category, description)

    return findings


def inspect_source_dir(source_dir: Path) -> list[tuple[str, str]]:
    documents, read_errors = read_documents(source_dir)
    return analyze_documents(documents, read_errors)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check a local legal source package for structural readiness; this does not establish legal approval.")
    parser.add_argument("--source-dir", required=True, type=Path, help="Local private directory containing the current handoff")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    findings = inspect_source_dir(args.source_dir)
    if findings:
        for category, description in findings:
            print(f"legal source blocker [{category}]: {description}")
        print(f"legal source structural readiness check failed: {len(findings)} blocker(s); no legal approval is inferred")
        return 1
    print("legal source structural readiness check passed; structural completeness is not legal approval")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
