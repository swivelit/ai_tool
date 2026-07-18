# Legal publication and future review intake

This is an intake checklist, not legal advice or legal-compliance certification.
The current policies are published through an authorised business-owner
attestation and have not been reviewed or approved by legal counsel. A future
professional review remains recommended.

## Keep raw source material private

1. From the repository root, create `private/legal-source/`.
2. Store raw PDF and DOCX files, lawyer correspondence, and approval evidence
   only in that directory.
3. Never place raw legal source files in `web/public`, `web/src`, tracked
   documentation, static assets, build output, or Git LFS.
4. Only exact public wording adopted through an owner attestation or genuine
   counsel approval belongs in
   `web/src/content/legalContent.json`.
5. The repository ignores the entire `private/` directory. The additional
   `*.legal-source.pdf` and `*.legal-source.docx` rules provide a filename-based
   backstop; PDF and DOCX files are not ignored globally because the repository
   may legitimately track other documents.
6. Before every commit, run:

   ```bash
   git status --short
   ```

   Raw private legal files must not appear. If they do, stop and correct their
   placement before staging anything. Do not commit KYC documents, signatures,
   private correspondence, approval communications, or identification records.

## Publication metadata

- Legal business identity:
- Registered/business address where required:
- Jurisdiction and governing-law decision:
- Public support contact:
- Privacy contact:
- Billing/refund contact:
- Effective date for each policy:
- Version for each policy:
- Publication path (`owner_attestation` or `counsel_approval`):
- Approver name or accountable business role:
- Approval/attestation date and reference:
- Legal-review status:
- Evidence location:

## Required public structures

- Terms and Conditions
- Privacy Policy
- Cancellation and Refund Policy
- Contact and Support
- AI Limitations
- Digital Service Delivery / Shipping Policy
- Pricing/top-up disclosure

For a future professional review, counsel should assess the final body text,
required statutory disclosures, audience/age restrictions, dispute language,
retention/deletion rules, subprocessors, delivery timing, refund
eligibility/timing, and support/escalation details appropriate to the operating
jurisdictions. That future review must not be inferred from an owner
attestation.

## Product facts for review

- Customers pay a gross rupee amount through Razorpay.
- Exactly 50% is converted internally to prepaid AI usage capacity; exactly 50% is service/platform allocation. Odd fractional user paise are floored to the platform.
- Customer-facing Token credits are model-dependent estimates, not cash, withdrawable value, or a fixed provider-token quota.
- Actual use varies by provider/model, cached input, and input/output mix.
- Gross payments/refunds can be shown in rupees; balances, grants, reversals, use, and limits are not presented as money.
- Checkout can be disabled while existing token credits remain usable.

## Publication handoff

The current seven policy bodies are version 1.0, effective 2026-07-17, and are
published under the owner attestation recorded in
`docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md`. See
`docs/LEGAL_PUBLICATION_STATUS.md` for the sanitized current status.

1. Check a private source package without uploading or changing it:

   ```bash
   python scripts/check-legal-source-readiness.py \
     --source-dir private/legal-source
   ```

   A pass means only that the package appears structurally complete. It is not
   legal approval.
2. Copy only exact adopted public wording and accountable publication metadata
   into `web/src/content/legalContent.json` without changing the page/component
   structure.
3. Set a non-draft version and ISO effective date for each page.
4. Use `publicationStatus=owner_approved` only with a matching tracked owner
   attestation that explicitly says counsel did not review or approve the
   policies. Use `publicationStatus=approved_by_counsel` only after a genuine
   counsel review with the required approval metadata. Plain `approved` is
   intentionally invalid because it is ambiguous.
5. Run `python scripts/check-legal-publication.py`.
6. Review every route on desktop/mobile and confirm footer/Settings links.
7. Record the deployed commit and screenshots in private release evidence.

Passing the publication checker authorises repository publication only. It does
not approve Razorpay Live Mode, which remains a separate operational and
financial release decision. Checkout must remain disabled until the distinct
Live-readiness process is completed.
