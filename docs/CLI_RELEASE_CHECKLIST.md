# Paid Chat CLI release closure

This checklist records the bounded `0.2.0-rc.4` release-candidate evidence. It
separates paid Chat, package distribution, local agent execution, and full
feature parity; it is not a publication approval or a parity claim.

CI baseline: run `34854653266` at `999da21d` passed backend, PostgreSQL, web,
Ubuntu CLI, and macOS CLI. Windows passed 68/68 tests, npm pack, and clean
install, then failed at the installed public launcher shim. This dirty
candidate has not been remotely rerun, so it is not reported as six green jobs.

| Gate | Evidence and source identity | State | Owner next action |
|---|---|---|---|
| Allowlisted paid Chat | Production Lite completion, wallet-debit smoke, website revoke/rejection, and explicit reauthorization are observed operator evidence. The installed controlled API release check passed login, refresh, streaming, recovery, usage, and retained-credential rejection. | Internal Chat candidate: ACCEPTED for scoped allowlisted review | Correlate a future approved request ID with the shared ledger if accounting evidence is required; do not infer it from wallet snapshots. |
| Public package distribution | CLI-only MIT notice, scope note, and dependency notice index are packaged; no registry publication was performed. | CONDITIONALLY READY / PUBLICATION PENDING | Confirm npm scope write permission separately from Swico login and owner-approve publication of the exact frozen archive. |
| Local coding agent | Agent flags remain disabled. Latest macOS sandbox diagnostic remains `unknown_failure`/`SIGABRT`; native hostile enforcement is not accepted. The prior CI revision `999da21d` passed the backend, PostgreSQL, web, Ubuntu CLI and macOS CLI jobs; this dirty candidate still needs a fresh owner-triggered run. | BLOCKED / UNVERIFIED | Owner obtains fresh Windows/client CI for the candidate and runs native hostile verification on a supported host. |
| Full feature parity | Cloud execution, executable plugins, mutating parallel agents, broad platform support, and other Codex-like workflows remain bounded or unavailable. | INCOMPLETE | Separate future product work; not part of this hotfix. |

Final artifact for this pass:

- version: `0.2.0-rc.4`
- source revision/dirty state: `999da21d67e85f319de1e936d2adbcd219da16cf`, dirty (implementation changes are uncommitted)
- filename: `swiveltechnologies-swico-0.2.0-rc.4.tgz`
- SHA-256: `cd4324cd69f1388a35bd69e172d83f8634be10957d8b689ebe1ab422193c2afe`
- fresh-prefix executable: `/var/folders/cf/v61848bn5rxcb9w0prpshwwc0000gn/T/swico-release-7MBjcH/prefix/bin/swico` (removed after acceptance)
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

For a stable desktop pilot prefix, use the explicit absolute path in every
new Terminal tab; do not rely on a vanished shell variable or replace the
older global installation:

```sh
mkdir -p "$HOME/.local/share/swico-pilot"
npm install --global --prefix "$HOME/.local/share/swico-pilot" ./swiveltechnologies-swico-0.2.0-rc.4.tgz
"$HOME/.local/share/swico-pilot/bin/swico" --version --json
"$HOME/.local/share/swico-pilot/bin/swico" usage --json
```

`swico usage` is a macOS shell command. `/usage`, `/exit`, `you>` and the
composer are inside Swico; `/exit` returns to the shell. Keep the exact
archive hash alongside the install record and stop if any preceding release
stage fails.
