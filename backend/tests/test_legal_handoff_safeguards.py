from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[2]


def _load_script(module_name: str, script_name: str):
    path = ROOT / "scripts" / script_name
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


SOURCE_CHECKER = _load_script("check_legal_source_readiness", "check-legal-source-readiness.py")
PUBLICATION_CHECKER = _load_script("check_legal_publication", "check-legal-publication.py")


def _descriptions(findings: list[tuple[str, str]]) -> list[str]:
    return [description for _category, description in findings]


def test_private_legal_source_and_filename_backstops_are_ignored():
    for candidate in (
        "private/legal-source/synthetic.pdf",
        "private/legal-source/synthetic.docx",
        "outside-private.legal-source.pdf",
        "outside-private.legal-source.docx",
    ):
        result = subprocess.run(
            ["git", "check-ignore", "--quiet", candidate],
            cwd=ROOT,
            check=False,
        )
        assert result.returncode == 0, candidate


def test_source_checker_rejects_placeholder_handoff_for_all_policy_bodies():
    source = """
Terms and Conditions
Effective date: [[COMPLETE]]
Version: DRAFT_NOT_APPROVED
[[PASTE EXACT APPROVED TERMS COPY]]
Privacy Policy
Cancellation and Refund Policy
Contact and Support
AI Use and Limitations Policy
Digital Service Delivery / Shipping Policy
Pricing and Token Credits
"""
    descriptions = _descriptions(SOURCE_CHECKER.analyze_documents([source]))
    assert "a COMPLETE placeholder remains" in descriptions
    assert "a PASTE EXACT APPROVED drafting instruction remains" in descriptions
    for policy in SOURCE_CHECKER.POLICIES:
        assert f"{policy.name}: complete exact policy body not found" in descriptions


def test_duplicate_source_files_do_not_duplicate_blocker_output(tmp_path: Path):
    content = "Terms and Conditions\n[[COMPLETE]]\n"
    (tmp_path / "copy-one.txt").write_text(content, encoding="utf-8")
    (tmp_path / "copy-two.md").write_text(content, encoding="utf-8")
    findings = SOURCE_CHECKER.inspect_source_dir(tmp_path)
    assert len(findings) == len(set(findings))
    assert sum(description == "a COMPLETE placeholder remains" for _category, description in findings) == 1


def test_docx_source_is_inspected_without_a_tracked_fixture(tmp_path: Path):
    document = tmp_path / "synthetic.docx"
    xml = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Terms and Conditions</w:t></w:r></w:p>
  <w:p><w:r><w:t>[[COMPLETE]]</w:t></w:r></w:p></w:body>
</w:document>"""
    with zipfile.ZipFile(document, "w") as archive:
        archive.writestr("word/document.xml", xml)
    documents, errors = SOURCE_CHECKER.read_documents(tmp_path)
    assert errors == []
    assert len(documents) == 1
    assert "Terms and Conditions" in documents[0]
    assert ("Drafting markers", "a COMPLETE placeholder remains") in SOURCE_CHECKER.analyze_documents(documents)


def test_domain_only_and_nil_public_contacts_are_rejected():
    source = """
Support email: Swiveltechnologies.in
Billing-support email: Nil
Privacy contact: Nil
"""
    descriptions = _descriptions(SOURCE_CHECKER.analyze_documents([source]))
    assert "support email contains only a domain rather than an email address" in descriptions
    assert "billing-support email must not be Nil" in descriptions
    assert "privacy email must not be Nil" in descriptions


def test_missing_policy_body_and_unresolved_retention_and_refund_are_reported():
    source = """
Terms and Conditions
This route heading has no full body.
Retention period: unresolved
Refund window: TBD
"""
    findings = SOURCE_CHECKER.analyze_documents([source])
    assert ("Policy bodies", "Terms and Conditions: complete exact policy body not found") in findings
    assert ("Privacy", "retention periods are unresolved") in findings
    assert ("Refunds", "the refund window is unresolved") in findings


def test_publication_checker_remains_blocked_and_status_is_unreviewed():
    data = json.loads((ROOT / "web" / "src" / "content" / "legalContent.json").read_text(encoding="utf-8"))
    assert data["publication"]["publicationStatus"] == "unreviewed"
    blockers = PUBLICATION_CHECKER.findings()
    assert "publicationStatus is not approved" in blockers
    for slug in PUBLICATION_CHECKER.REQUIRED_PAGES:
        assert f"{slug}: missing policy body" in blockers


def test_no_raw_pdf_docx_or_private_material_is_tracked():
    tracked = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout.decode("utf-8").split("\0")
    forbidden = [
        path for path in tracked
        if path.startswith("private/") or path.casefold().endswith((".pdf", ".docx"))
    ]
    assert forbidden == []


def test_legal_handoff_keeps_billing_safety_defaults():
    example = (ROOT / "backend" / ".env.example").read_text(encoding="utf-8")
    assert "RAZORPAY_MODE=test" in example
    assert "BILLING_CHECKOUT_ENABLED=false" in example
    assert "BILLING_CREDIT_PERCENT=50" in example
    pricing = (ROOT / "backend" / "app" / "billing" / "pricing.py").read_text(encoding="utf-8")
    assert 'env_decimal("BILLING_CREDIT_PERCENT", "50")' in pricing
