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


def _publication_data() -> dict:
    return json.loads((ROOT / "web" / "src" / "content" / "legalContent.json").read_text(encoding="utf-8"))


def _publication_findings(
    tmp_path: Path,
    monkeypatch,
    data: dict,
    *,
    attestation: str | None = None,
) -> list[str]:
    content_path = tmp_path / "legalContent.json"
    content_path.write_text(json.dumps(data), encoding="utf-8")
    attestation_path = tmp_path / "OWNER_LEGAL_PUBLICATION_ATTESTATION.md"
    if attestation is None:
        attestation = (ROOT / "docs" / "OWNER_LEGAL_PUBLICATION_ATTESTATION.md").read_text(encoding="utf-8")
    if attestation:
        attestation_path.write_text(attestation, encoding="utf-8")
    monkeypatch.setattr(PUBLICATION_CHECKER, "CONTENT", content_path)
    monkeypatch.setattr(PUBLICATION_CHECKER, "OWNER_ATTESTATION", attestation_path)
    return PUBLICATION_CHECKER.findings()


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


def test_actual_owner_attested_publication_passes(capsys):
    data = _publication_data()
    assert data["publication"]["publicationStatus"] == "owner_approved"
    assert PUBLICATION_CHECKER.findings() == []
    assert PUBLICATION_CHECKER.main() == 0
    assert capsys.readouterr().out.strip() == (
        "legal publication check passed (owner-attested publication; "
        "no counsel approval or legal advice inferred)"
    )


def test_owner_status_without_approver_fails(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["approval"].pop("approvedByNameOrRole")
    assert "owner-attested publication is missing a valid approvedByNameOrRole" in _publication_findings(
        tmp_path, monkeypatch, data
    )


def test_owner_status_without_attestation_reference_fails(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["approval"].pop("writtenAttestationReference")
    assert "owner-attested publication is missing a valid writtenAttestationReference" in _publication_findings(
        tmp_path, monkeypatch, data
    )


def test_owner_status_without_approval_date_fails(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["approval"].pop("approvalDate")
    assert "owner-attested publication is missing approvalDate" in _publication_findings(
        tmp_path, monkeypatch, data
    )


def test_owner_status_without_explicit_no_counsel_review_fails(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["approval"].pop("legalReviewStatus")
    assert (
        "owner-attested publication requires legalReviewStatus=not_reviewed_by_counsel"
        in _publication_findings(tmp_path, monkeypatch, data)
    )


def test_missing_owner_attestation_document_fails(tmp_path: Path, monkeypatch):
    data = _publication_data()
    blockers = _publication_findings(tmp_path, monkeypatch, data, attestation="")
    assert "owner-attested publication requires docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md" in blockers


def test_mismatched_owner_attestation_reference_fails(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["approval"]["writtenAttestationReference"] = "SWICO-OWNER-PUBLICATION-MISMATCH"
    blockers = _publication_findings(tmp_path, monkeypatch, data)
    assert "owner-attestation document reference does not match publication metadata" in blockers


def test_mismatched_owner_attestation_date_fails(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["approval"]["approvalDate"] = "2026-07-19"
    blockers = _publication_findings(tmp_path, monkeypatch, data)
    assert "owner-attestation document date does not match publication metadata" in blockers


def test_owner_approval_date_must_be_a_valid_iso_date(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["approval"]["approvalDate"] = "2026-02-30"
    blockers = _publication_findings(tmp_path, monkeypatch, data)
    assert "owner-attested publication approvalDate must use valid YYYY-MM-DD format" in blockers


def test_plain_approved_status_is_rejected_as_ambiguous(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["publicationStatus"] = "approved"
    blockers = _publication_findings(tmp_path, monkeypatch, data)
    assert "publicationStatus=approved is ambiguous; use owner_approved or approved_by_counsel" in blockers


def test_publication_status_and_approval_type_must_match(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["approval"]["approvalType"] = "counsel_approval"
    blockers = _publication_findings(tmp_path, monkeypatch, data)
    assert "owner-approved publication requires approvalType=owner_attestation" in blockers

    data = _publication_data()
    data["publication"]["publicationStatus"] = "approved_by_counsel"
    blockers = _publication_findings(tmp_path, monkeypatch, data)
    assert "counsel-approved publication requires approvalType=counsel_approval" in blockers


def test_synthetic_counsel_status_requires_nonempty_counsel_fields(tmp_path: Path, monkeypatch):
    data = _publication_data()
    data["publication"]["publicationStatus"] = "approved_by_counsel"
    data["publication"]["approval"] = {
        "approvalType": "counsel_approval",
        "counselNameOrFirm": "",
        "writtenApprovalReference": "",
        "approvalDate": "",
    }
    blockers = _publication_findings(tmp_path, monkeypatch, data)
    assert "counsel-approved publication is missing a valid counselNameOrFirm" in blockers
    assert "counsel-approved publication is missing a valid writtenApprovalReference" in blockers
    assert "counsel-approved publication is missing approvalDate" in blockers


def test_empty_policies_placeholders_and_invalid_emails_remain_rejected(tmp_path: Path, monkeypatch):
    data = _publication_data()
    publication = data["publication"]
    publication["supportEmail"] = "swiveltechnologies.in"
    publication["billingSupportEmail"] = "Nil"
    publication["privacyEmail"] = "not-an-email"
    data["pages"]["terms"]["sections"][0]["body"] = ""
    data["pages"]["privacy"]["sections"][0]["body"] = "TODO"
    blockers = _publication_findings(tmp_path, monkeypatch, data)
    assert "support email contains only a domain" in blockers
    assert "billing-support email must not be Nil" in blockers
    assert "privacy email is not a valid email address" in blockers
    assert "terms: empty section: Eligibility and accounts" in blockers
    assert "privacy: contains TODO marker" in blockers


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
