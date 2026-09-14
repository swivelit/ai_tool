# Paid Chat CLI release closure

This checklist records the bounded `0.2.0-rc.8` release-candidate evidence. It
separates paid Chat, package distribution, local agent execution, and full
feature parity; it is not a publication approval or a parity claim.

Historical RC6 evidence remains recorded below. RC7 baseline: run
`34892384342` at `8ea9dfb4cc431d1c780569f1f45bc169864590f0` passed backend,
PostgreSQL, web and Ubuntu CLI. macOS passed through installed task-only plan
consent, then failed same-process recovery because its harness sent recovery
commands before synchronized prompts. Windows passed ordinary 81/81 tests and
then failed the native ConPTY test at `parent-eof`; Windows `release:check`
did not run. This RC8 pass makes recovery prompt-driven and aligns the native
EOF probe with Swico's Ctrl+D/EOT contract. Fresh CI is required.

| Gate | Evidence and source identity | State | Owner next action |
|---|---|---|---|
| Allowlisted paid Chat | Production Lite completion, wallet-debit smoke, website revoke/rejection, and explicit reauthorization remain observed evidence. RC8 controlled installed recovery, refresh, streaming and retained-session checks passed locally without paid calls. | ACCEPTED for scoped allowlisted review | Correlate any future approved request ID with the shared ledger; do not infer accounting from wallet snapshots. |
| Public package distribution | CLI-only MIT notice, scope note, and dependency notice index are packaged; no registry publication was performed. | CONDITIONALLY READY / PUBLICATION PENDING | Confirm npm scope write permission separately from Swico login and owner-approve publication of the exact frozen archive. |
| Local coding agent | Agent flags remain disabled. Latest macOS sandbox diagnostic remains `unknown_failure`/`SIGABRT`; native hostile enforcement is not accepted. A green ConPTY helper is terminal acceptance only, never sandbox proof. | BLOCKED / UNVERIFIED | Owner obtains fresh Windows/client CI and separately runs native hostile verification on a supported host. |
| Full feature parity | Cloud execution, executable plugins, mutating parallel agents, broad platform support, and other Codex-like workflows remain bounded or unavailable. | INCOMPLETE | Separate future product work; not part of this hotfix. |

RC8 artifact for this pass:

- version: `0.2.0-rc.8`
- source revision/dirty state: `8ea9dfb4cc431d1c780569f1f45bc169864590f0`, dirty=true (local RC8 changes are uncommitted)
- filename: `swiveltechnologies-swico-0.2.0-rc.8.tgz`
- SHA-256: `49ee69c7f8879449e78b59af312c40e4dcad0ea7091ac6d6743cb72e3af33e8e`
- fresh-prefix executable: `/var/folders/cf/v61848bn5rxcb9w0prpshwwc0000gn/T/swico-release-ck1emI/prefix/bin/swico` (removed after acceptance)
- package contains `dist/terminal_ui.js`, the MIT scope files, dependency
  notices, compiled CLI files, and no source/tests/secrets. `dist/build_identity.js`
  records the source revision and dirty state captured by the build; installed
  `--version --json` and `doctor` matched that identity outside the Git checkout.

Local validation for this RC8 source passed `npm ci`, typecheck, lint, all 81
CLI tests, the controlled installed release check, the package dry-run, the
tracked-secret scan, and `git diff --check`. Native Windows ConPTY acceptance
(`npm run test:conpty-native`) is **NOT RUN** on this macOS host; it is an
explicit Windows CI step and must not be inferred from the Unix PTY pass.

If a future PTY stage fails, the retained failure report includes the bounded
stage elapsed time, helper PID/command, child code/signal, timeout and forced-
termination state, last lifecycle state, output byte count, and sanitized
helper stderr. It does not retain prompts, environment variables, credentials,
or disposable credential directories.

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
shasum -a 256 ./swiveltechnologies-swico-0.2.0-rc.8.tgz
npm install --global --prefix "$HOME/.local/share/swico-pilot" ./swiveltechnologies-swico-0.2.0-rc.8.tgz
"$HOME/.local/share/swico-pilot/bin/swico" --version --json
"$HOME/.local/share/swico-pilot/bin/swico" usage --json
```

`swico usage` is a macOS shell command. `/usage`, `/exit`, `you>` and the
composer are inside Swico; `/exit` returns to the shell. Keep the exact
archive hash alongside the install record and stop if any preceding release
stage fails.
