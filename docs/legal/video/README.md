# Website template-video legal release pack

This directory contains reviewable product-language and operational guidance.
It does not grant a model, movie, performer, face, audio or music licence and
it is not counsel approval. Third-party rights remain separate operator-owned
evidence and are checked by the worker audit.

The publishable page candidate is maintained in
`web/src/content/videoLegalDraft.json`. It is intentionally not copied into
the live `legalContent.json` by a build or deploy. An accountable owner must
run the local helper from the repository root after checking the exact text:

```sh
python scripts/publish-video-legal.py \
  --owner-attestation \
  --approver-role "REAL ACCOUNTABLE OWNER ROLE" \
  --approval-date "YYYY-MM-DD" \
  --dry-run
```

Replace the quoted values with real values before execution; the helper
refuses placeholders. A non-dry run also requires all three explicit
confirmation flags documented in `OWNER_PUBLICATION_ATTESTATION_GUIDE.md`.
It makes private backups and validates the exact page SHA-256 before any
replacement. It never contacts Render, a payment provider or an email
provider.

The publication sequence is:

1. obtain genuine model, movie, performer/source-face and audio/music rights;
2. inspect the draft and run the dry-run helper;
3. record an owner attestation, explicitly not a counsel approval;
4. run the helper with the three confirmations;
5. run the legal and video release checks;
6. separately complete worker/model/template QA and operator release approval.

Do not put private evidence documents, customer media, identity documents or
credentials in this repository.
