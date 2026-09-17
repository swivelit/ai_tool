# Paid Chat CLI release closure and stable promotion

Current stable release: `@swiveltechnologies/swico@0.2.1` is published from
the canonical CI artifact with provenance. This checklist separates paid Chat,
package distribution, local agent execution, and full feature parity; it is not
npm publication approval or a parity claim.

The remainder of the artifact details below records historical `0.2.0-rc.8`
evidence and the superseded `0.2.0` promotion plan. Do not treat those hashes,
run IDs, or pending states as current release evidence.

Historical RC6 and RC7 evidence remains recorded by its original run IDs. The
accepted RC8 baseline is run `34911573230` at
`f029622c00ff903ccda9e3e95823abd58ee43411`. All seven checks passed: backend,
PostgreSQL lifecycle, web, Ubuntu CLI, macOS CLI, Windows CLI, and the
dependent canonical artifact job. Windows passed native ConPTY exits, nonzero
exit preservation, Unicode output, parent EOF/Ctrl+D, and the complete
installed release check with `accepted: true`, `dirty: false`, and the exact
checked-out revision. This is the first fully green cross-platform Chat CLI
baseline with a retained canonical artifact.

The canonical artifact job ran only after the backend, PostgreSQL, web, and
complete CLI matrix succeeded. It rebuilt the exact RC8 version, validated
clean embedded identity and package contents, and uploaded only
`swico-cli-0.2.0-rc.8-release-candidate` containing the tarball and minimal
release manifest. The retained tarball is
`swiveltechnologies-swico-0.2.0-rc.8.tgz` with SHA-256
`8866e8eda089ad096f3c11203dbba77af722deb9a594ffd66cdb45a24ca083cb`.

| Gate | Evidence and source identity | State | Owner next action |
|---|---|---|---|
| Paid Chat CLI technical RC | Production Lite completion, wallet-debit smoke, website revoke/rejection, explicit reauthorization, and RC8 request-correlated billing acceptance are recorded. RC8 controlled installed recovery, refresh, streaming, and retained-session checks passed; all seven CI checks passed. | ACCEPTED technical RC | Historical RC8 gate complete. |
| Historical stable `0.2.0` promotion candidate | Superseded by the published `0.2.1` release. | HISTORICAL | Do not reuse this candidate or its artifact. |
| Current public npm distribution | `@swiveltechnologies/swico@0.2.1` is published immutably with provenance. | PUBLISHED | Use the protected workflow for future versions. |
| Local coding agent | Agent flags remain disabled. Latest macOS sandbox diagnostic remains `unknown_failure`/`SIGABRT`; native hostile enforcement is not accepted. A green ConPTY helper is terminal acceptance only, never sandbox proof. | BLOCKED / UNVERIFIED | Run the separate native hostile sandbox and disposable coding-workflow milestone; do not infer it from green Chat CI. |
| Full feature parity | Cloud execution, executable plugins, mutating parallel agents, broad platform support, and other Codex-like workflows remain bounded or unavailable. | INCOMPLETE | Separate future product work; not part of this hotfix. |

Package identity audit: the authoritative scope and executable are defined in
`cli/package.json` and `cli/package-lock.json`, asserted by
`cli/scripts/release-check.mjs` and `cli/scripts/validate-release-artifact.mjs`,
and surfaced by `cli/src/cli.ts`. Tracked references are limited to those
files, `cli/README.md`, `cli/LICENSE_SCOPE.md`, `docs/CLI.md`, this checklist,
`docs/CLI_LIVE_ACCEPTANCE.md`, and `swico-cli-mit.patch`. The historical
`@swico/swico` name appears only in install/migration guidance. No backend
route, authentication, terminal-session identity, billing,
reservation/idempotency, provider/model routing, Firebase, or database schema
assumption is tied to the npm scope; changing it later is distribution and
documentation work, not a server protocol change.

The authoritative historical RC8 artifact is the GitHub artifact, not a local
rebuild:

- artifact: `swico-cli-0.2.0-rc.8-release-candidate`
- tarball: `swiveltechnologies-swico-0.2.0-rc.8.tgz`
- artifact ID: `10374538515`
- source revision: `f029622c00ff903ccda9e3e95823abd58ee43411`
- dirty: `false`
- SHA-256: `8866e8eda089ad096f3c11203dbba77af722deb9a594ffd66cdb45a24ca083cb`
- manifest Node: `v22.23.2`

The superseded historical stable candidate was `0.2.0`. Do not use it for a
current install or record it as the current release. The published `0.2.1`
manifest and tarball from the canonical workflow are authoritative for the
current package identity and artifact details.

If the owner later requires `@swico/swico`, update package.json, both package
identity entries in package-lock.json, README/install/publish guidance, license
scope, release-check assertions, validator assertions, tarball filename and
CI artifact naming, migration/uninstall guidance, and affected tests. Verify
write access to the `@swico` npm scope before stable promotion. A renamed
package requires a fresh seven-check CI run, a new canonical artifact, and new
live acceptance; the current `@swiveltechnologies` artifact cannot be reused.

RC8 source validation and its canonical workflow passed `npm ci`, typecheck,
lint, all 81 CLI tests, the controlled installed release check, package
allowlist/build-identity validation, artifact upload, the tracked-secret scan,
and `git diff --check`. Native Windows ConPTY and installed Windows acceptance
are evidenced by CI run `34911573230`; they must not be inferred from a local
Unix PTY pass.

If a future PTY stage fails, the retained failure report includes the bounded
stage elapsed time, helper PID/command, child code/signal, timeout and forced-
termination state, last lifecycle state, output byte count, and sanitized
helper stderr. It does not retain prompts, environment variables, credentials,
or disposable credential directories.

The historical RC8 archive is retained by GitHub but is not published to npm.
The superseded `0.2.0` stable archive was not the current release and must not
be reused. Do not claim registry presence or reuse it after any source or
approved-license change without a new clean build and acceptance. Rollback is
schema-preserving: restore the previous retained artifact and leave the
deployed database at the current repository head,
`20260916_cli_cloud_jobs` (after `20260915_weekly_tester_credit`).

For the operator: the RC8 live acceptance record and exact artifact procedure
are in `docs/CLI_LIVE_ACCEPTANCE.md`. Use `swico usage` at the macOS shell and
`/usage` inside an interactive Swico session. Current stable acceptance must
use the published `0.2.1` canonical CI artifact and its generated manifest,
not the historical RC8 tarball.
Render is not involved in this CLI-only change. The installed UI scope is
recorded in `docs/CLI_TUI_ACCEPTANCE.md`.

For a current `0.2.1` desktop acceptance prefix, use the explicit absolute
path in every new Terminal tab; compare the downloaded hash to the generated
manifest and do not replace the older global installation:

```sh
mkdir -p "$HOME/.local/share/swico-0.2.1"
shasum -a 256 ./swiveltechnologies-swico-0.2.1.tgz
npm install --global --prefix "$HOME/.local/share/swico-0.2.1" ./swiveltechnologies-swico-0.2.1.tgz
"$HOME/.local/share/swico-0.2.1/bin/swico" --version --json
"$HOME/.local/share/swico-0.2.1/bin/swico" usage --json
```

`swico usage` is a macOS shell command. `/usage`, `/exit`, `you>` and the
composer are inside Swico; `/exit` returns to the shell. Keep the exact
archive hash alongside the install record and stop if any preceding release
stage fails.
