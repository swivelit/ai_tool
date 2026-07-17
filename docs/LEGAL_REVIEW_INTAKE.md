# Legal publication review intake

This is an intake checklist, not legal advice and not a representation that review is complete. Counsel or an authorized business owner must provide the approved text and publication metadata.

## Keep raw source material private

1. From the repository root, create `private/legal-source/`.
2. Store raw PDF and DOCX files, lawyer correspondence, and approval evidence
   only in that directory.
3. Never place raw legal source files in `web/public`, `web/src`, tracked
   documentation, static assets, build output, or Git LFS.
4. Only final, exact, approved public wording belongs in
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
- Approver, approval date, and evidence location:

## Required public structures

- Terms and Conditions
- Privacy Policy
- Cancellation and Refund Policy
- Contact and Support
- AI Limitations
- Digital Service Delivery / Shipping Policy
- Pricing/top-up disclosure

For every section, counsel should supply final body text, required statutory disclosures, audience/age restrictions, dispute language, retention/deletion rules, subprocessors, delivery timing, refund eligibility/timing, and support/escalation details appropriate to the operating jurisdictions.

## Product facts for review

- Customers pay a gross rupee amount through Razorpay.
- Exactly 50% is converted internally to prepaid AI usage capacity; exactly 50% is service/platform allocation. Odd fractional user paise are floored to the platform.
- Customer-facing Token credits are model-dependent estimates, not cash, withdrawable value, or a fixed provider-token quota.
- Actual use varies by provider/model, cached input, and input/output mix.
- Gross payments/refunds can be shown in rupees; balances, grants, reversals, use, and limits are not presented as money.
- Checkout can be disabled while existing token credits remain usable.

## Publication handoff

The current handoff is structurally incomplete. Route headings and a partially
completed business workbook are not substitutes for the seven exact policy
bodies. See `docs/LEGAL_PUBLICATION_STATUS.md` for the current blocker list.

1. Check a private source package without uploading or changing it:

   ```bash
   python scripts/check-legal-source-readiness.py \
     --source-dir private/legal-source
   ```

   A pass means only that the package appears structurally complete. It is not
   legal approval.
2. After every blocker is resolved, copy only final approved public wording and
   publication metadata into `web/src/content/legalContent.json` without
   changing the page/component structure.
3. Set a non-draft version and ISO effective date for each page.
4. Set `publicationStatus` to `approved` only when complete exact policy bodies
   and retained written approval evidence have been supplied.
5. Run `python scripts/check-legal-publication.py`.
6. Review every route on desktop/mobile and confirm footer/Settings links.
7. Record the deployed commit and screenshots in private release evidence.

Razorpay Live Mode and checkout must remain disabled while this checker reports blockers.
