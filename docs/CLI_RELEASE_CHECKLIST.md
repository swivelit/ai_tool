# Paid Chat CLI release closure

This checklist records the bounded `0.2.0-rc.1` release-candidate evidence. It
separates paid Chat, package distribution, local agent execution, and full
feature parity; it is not a publication approval or a parity claim.

| Gate | Evidence and source identity | State | Owner next action |
|---|---|---|---|
| Allowlisted paid Chat | Production Lite completion and website revoke/rejection are observed operator evidence; the installed controlled API release check passed login, refresh, streaming, recovery, usage, and retained-credential rejection. This pass is based on `282fec389a87b18de7ee4bd19097ea3516043346` with a dirty working tree. | Internal Chat candidate: ACCEPTED for scoped allowlisted review | Correlate a future approved request ID with the shared ledger if accounting evidence is required; do not infer it from wallet snapshots. |
| Public package distribution | CLI-only MIT notice, scope note, and dependency notice index are packaged; no registry publication was performed. | CONDITIONALLY READY / PUBLICATION PENDING | Confirm npm scope write permission separately from Swico login and owner-approve publication of the exact frozen archive. |
| Local coding agent | Agent flags remain disabled. Latest ordinary macOS diagnostic is `unknown_failure`/`SIGABRT`; native hostile enforcement is not accepted. PostgreSQL lifecycle CI is still unverified. | BLOCKED / UNVERIFIED | Owner runs native hostile verification on a supported host and the existing PostgreSQL lifecycle job on the tested commit. |
| Full feature parity | Cloud execution, executable plugins, mutating parallel agents, broad platform support, and other Codex-like workflows remain bounded or unavailable. | INCOMPLETE | Separate future product work; not part of this hotfix. |

Final artifact for this pass:

- version: `0.2.0-rc.1`
- source revision/dirty state: `282fec389a87b18de7ee4bd19097ea3516043346`, dirty
- filename: `swiveltechnologies-swico-0.2.0-rc.1.tgz`
- SHA-256: `33e59b2dd391160299d0f676d90867c12828df2ae3158bad5d69338678db2ff6`
- fresh-prefix executable: `/private/tmp/swico-final-prefix.a9QI2D/bin/swico`
- package contains `dist/terminal_ui.js`, the MIT scope files, dependency
  notices, compiled CLI files, and no source/tests/secrets

The final archive is local only. Do not publish it, claim registry presence,
or reuse it after any source or approved-license change without rebuilding and
re-running acceptance. No Render redeploy, environment change, or migration is
needed for this CLI/docs-only pass. Rollback is schema-preserving: restore the
previous retained artifact and leave the deployed database and migration at
`20260913_cli_reservations`.

For the operator: use `swico usage` at the macOS shell and `/usage` inside an
interactive Swico session. Run the owner-triggered GitHub PostgreSQL job on
the tested commit; a skipped or unavailable job is not a pass. Render is not
involved in this CLI-only change. The installed PTY transcript is recorded in
`docs/CLI_TUI_ACCEPTANCE.md`.
