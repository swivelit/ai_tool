# Paid Chat CLI release closure

This checklist records the bounded `0.2.0-rc.2` release-candidate evidence. It
separates paid Chat, package distribution, local agent execution, and full
feature parity; it is not a publication approval or a parity claim.

| Gate | Evidence and source identity | State | Owner next action |
|---|---|---|---|
| Allowlisted paid Chat | Production Lite completion, wallet-debit smoke, website revoke/rejection, and explicit reauthorization are observed operator evidence. The installed controlled API release check passed login, refresh, streaming, recovery, usage, and retained-credential rejection. | Internal Chat candidate: ACCEPTED for scoped allowlisted review | Correlate a future approved request ID with the shared ledger if accounting evidence is required; do not infer it from wallet snapshots. |
| Public package distribution | CLI-only MIT notice, scope note, and dependency notice index are packaged; no registry publication was performed. | CONDITIONALLY READY / PUBLICATION PENDING | Confirm npm scope write permission separately from Swico login and owner-approve publication of the exact frozen archive. |
| Local coding agent | Agent flags remain disabled. Latest ordinary macOS diagnostic is `unknown_failure`/`SIGABRT`; native hostile enforcement is not accepted. PostgreSQL lifecycle passed on the prior `b57e687` CI revision; fresh evidence for this dirty candidate is pending. | BLOCKED / UNVERIFIED | Owner obtains fresh Windows/PostgreSQL/client CI for the candidate and runs native hostile verification on a supported host. |
| Full feature parity | Cloud execution, executable plugins, mutating parallel agents, broad platform support, and other Codex-like workflows remain bounded or unavailable. | INCOMPLETE | Separate future product work; not part of this hotfix. |

Final artifact for this pass:

- version: `0.2.0-rc.2`
- source revision/dirty state: `b57e687280a23e4ca769b2a7db949333025a72c2`, dirty (implementation changes are uncommitted)
- filename: `swiveltechnologies-swico-0.2.0-rc.2.tgz`
- SHA-256: `a656485f320a3ead78da4b7e601d3f0c151e53fe1d64c18c1ad6369dc08760a4`
- fresh-prefix executable: `/private/tmp/swico-rc2-installed-aTljFc/bin/swico` (`--version --json` confirmed 0.2.0-rc.2; embedded revision/dirty are honestly `unknown`)
- package contains `dist/terminal_ui.js`, the MIT scope files, dependency
  notices, compiled CLI files, and no source/tests/secrets

The final archive is local only. Do not publish it, claim registry presence,
or reuse it after any source or approved-license change without rebuilding and
re-running acceptance. No Render redeploy, environment change, or migration is
needed for this CLI/docs-only pass. Rollback is schema-preserving: restore the
previous retained artifact and leave the deployed database and migration at
`20260913_cli_reservations`.

For the operator: use `swico usage` at the macOS shell and `/usage` inside an
interactive Swico session. Run the owner-triggered GitHub Windows job on the
candidate; a skipped or unavailable job is not a pass. Render is not involved
in this CLI-only change. The installed UI scope is recorded in
`docs/CLI_TUI_ACCEPTANCE.md`.
