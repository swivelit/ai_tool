# Paid Chat CLI release closure

This checklist records the bounded `0.2.0-rc.8` release-candidate evidence. It
separates paid Chat, package distribution, local agent execution, and full
feature parity; it is not a publication approval or a parity claim.

Historical RC6 and RC7 evidence remains recorded by its original run IDs. The
accepted RC8 baseline is run `34908695927` at
`f8b12c9dfa6f8d5711c5b6370e457b15d7ef8276`. Backend, PostgreSQL, web, Ubuntu,
macOS, and Windows all passed. Windows passed native ConPTY exits, nonzero
exit preservation, Unicode output, parent EOF/Ctrl+D, and the complete
installed release check with `accepted: true`, `dirty: false`, and the exact
checked-out revision. This is the first fully green cross-platform Chat CLI
baseline.

The closure change adds a dependent Ubuntu `cli-release-artifact` job. It runs
only after the backend, PostgreSQL, web, and complete CLI matrix succeed,
rebuilds the exact version, validates clean embedded identity and package
contents, and uploads only `swico-cli-0.2.0-rc.8-release-candidate` containing
the tarball and minimal release manifest. That new job is pending the next
owner-reviewed CI run.

| Gate | Evidence and source identity | State | Owner next action |
|---|---|---|---|
| Paid Chat CLI technical RC | Production Lite completion, wallet-debit smoke, website revoke/rejection, and explicit reauthorization remain observed evidence. RC8 controlled installed recovery, refresh, streaming, and retained-session checks passed; all six CI jobs passed. | ACCEPTED technical RC | Complete operator live paid-account acceptance and request-correlated billing verification. |
| Public npm distribution | CLI-only MIT notice, scope note, dependency notice index, and clean CI artifact validation are in place; no registry publication was performed. | CONDITIONALLY READY / PUBLICATION PENDING | Retain/download the canonical CI artifact, confirm npm scope write permission, and owner-approve beta publication. |
| Local coding agent | Agent flags remain disabled. Latest macOS sandbox diagnostic remains `unknown_failure`/`SIGABRT`; native hostile enforcement is not accepted. A green ConPTY helper is terminal acceptance only, never sandbox proof. | BLOCKED / UNVERIFIED | Run the separate native hostile sandbox and disposable coding-workflow milestone; do not infer it from green Chat CI. |
| Full feature parity | Cloud execution, executable plugins, mutating parallel agents, broad platform support, and other Codex-like workflows remain bounded or unavailable. | INCOMPLETE | Separate future product work; not part of this hotfix. |

Package identity audit: the authoritative scope and executable are defined in
`cli/package.json` and `cli/package-lock.json`, asserted by
`cli/scripts/release-check.mjs`, and surfaced by `cli/src/cli.ts`. The same
identity appears in the CLI README/license scope, release/live docs, publisher
and install commands, and the MIT patch record. The historical
`@swico/swico` name appears only in migration guidance telling users to remove
that unavailable package. Repository search found no backend, web, database,
session, billing, authentication, provider, or protocol assumption tied to the
npm scope; changing it later is distribution/docs/package metadata work, but
would require a fresh full CI run and owner approval before stable `0.2.0`.

Local RC8 artifact for this pass:

- version: `0.2.0-rc.8`
- source revision/dirty state: `f8b12c9dfa6f8d5711c5b6370e457b15d7ef8276`, dirty=true (release-closure edits are uncommitted locally)
- filename: `swiveltechnologies-swico-0.2.0-rc.8.tgz`
- SHA-256: `6511fde86dfc7ef9fe2c8322c910750ed299b544453b42f4a34e71b1a7daa5b9`
- fresh-prefix executable: `/var/folders/cf/v61848bn5rxcb9w0prpshwwc0000gn/T/swico-release-bIDOUn/prefix/bin/swico` (removed after acceptance)
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
interactive Swico session. The accepted RC8 CI run is `34908695927`; the new
canonical artifact job must run after this closure change before its artifact
is treated as current. Render is not involved in this CLI-only change. The
installed UI scope is recorded in `docs/CLI_TUI_ACCEPTANCE.md`.

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
