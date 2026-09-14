# Paid Chat CLI release closure

This checklist records the bounded `0.1.0` release-candidate evidence. It is
not a publication approval or a claim of full feature parity.

| Gate | Evidence and source identity | State | Owner next action |
|---|---|---|---|
| Allowlisted paid Chat | Production Lite completion and website revoke/rejection are observed operator evidence; the installed controlled API release check passed login, refresh, streaming, recovery, usage, and retained-credential rejection. Final source is `fc92e68545d01234b5087059db7bb95fc75ae4be` with a dirty working tree from this pass. | Internal Chat candidate: ACCEPTED for scoped allowlisted review | Correlate a future approved request ID with the shared ledger if accounting evidence is required; do not infer it from wallet snapshots. |
| Public package distribution | Clean-prefix installed artifact passed release checks. No owner-approved CLI package SPDX expression or `SEE LICENSE IN` notice is present, and no registry publication was performed. | BLOCKED | Supply approved terms and notices, then rebuild and re-run the exact release check before owner-operated publication. Confirm npm scope write permission separately from Swico login. |
| Local coding agent | Agent flags remain disabled. Latest ordinary macOS diagnostic is `unknown_failure`/`SIGABRT`; native hostile enforcement is not accepted. PostgreSQL lifecycle CI is still unverified. | BLOCKED / UNVERIFIED | Owner runs native hostile verification on a supported host and the existing PostgreSQL lifecycle job on the tested commit. |
| Full feature parity | Cloud execution, executable plugins, mutating parallel agents, broad platform support, and other Codex-like workflows remain bounded or unavailable. | INCOMPLETE | Separate future product work; not part of this hotfix. |

Final artifact for this pass:

- version: `0.1.0`
- filename: `swiveltechnologies-swico-0.1.0.tgz`
- SHA-256: `7a30a5410f7110afaaf140db0f80aee6782b796f9f0fa4ea55fb35f0eb700b3e`
- installed executable used by the clean-prefix check: temporary path printed
  by `npm run release:check -- --keep-artifact`; it is removed after the check
- package contains the compiled command registry, usage formatter,
  `terminal_output.js`, and the package README; no source/tests/secrets are
  included

The final archive is local only. Do not publish it, claim registry presence,
or reuse it after any source or approved-license change without rebuilding and
re-running acceptance. No Render redeploy, environment change, or migration is
needed for this CLI/docs-only pass. Rollback is schema-preserving: restore the
previous retained artifact and leave the deployed database and migration at
`20260913_cli_reservations`.

For the operator: use `swico usage` at the macOS shell and `/usage` inside an
interactive Swico session. Run the owner-triggered GitHub PostgreSQL job on
the tested commit; a skipped or unavailable job is not a pass. Render is not
involved in this CLI-only change.
