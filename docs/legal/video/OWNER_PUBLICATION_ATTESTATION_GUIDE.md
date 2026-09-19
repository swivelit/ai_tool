# Owner publication attestation guide

The owner publication helper is local and explicit. It does not send content,
contact counsel, deploy the website or mutate a database. It preserves the
canonical page set, changes only the legal pages from the reviewed video
draft, calculates the exact page SHA-256 and validates the candidate with the
publication checker.

Run a dry run first:

```sh
python scripts/publish-video-legal.py \
  --owner-attestation \
  --approver-role "REAL ACCOUNTABLE OWNER ROLE" \
  --approval-date "YYYY-MM-DD" \
  --dry-run
```

After replacing the values with real information, publish only with:

```sh
python scripts/publish-video-legal.py \
  --owner-attestation \
  --approver-role "REAL ACCOUNTABLE OWNER ROLE" \
  --approval-date "YYYY-MM-DD" \
  --confirm-authority \
  --confirm-not-counsel-reviewed \
  --confirm-right-to-publish
```

The helper refuses placeholders, requires an explicit statement that counsel
did not review or approve the pages, writes mode-0600 private backups, and
records the exact approved page SHA-256 in both publication metadata and the
private attestation. It does not prove third-party rights. Never run it with
sample names, fake dates, fabricated rights or copied placeholder documents.
