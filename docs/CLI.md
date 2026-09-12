# Swico CLI

Swico CLI is a third client for existing Swico accounts. It uses the account's
Chat subscription or wallet and receives only public tier labels. Provider
names, provider keys and internal model identifiers are never CLI inputs.
Swico Free retains its existing eligibility and local-only inference rules.

## Rollout and installation

Customers install the public package without an npm account:

```bash
npm install -g @swiveltechnologies/swico
swico login
swico
```

An earlier unavailable scope was `@swico/swico`; remove it before installing
the official package so the shared executable is unambiguous:

```bash
npm uninstall -g @swico/swico
npm install -g @swiveltechnologies/swico
```

From the repository root while developing:

```bash
npm --prefix cli ci
npm --prefix cli run build
npm --prefix cli link
swico --help
```

The package can be built, packed, checked, and installed into a clean local
prefix without publishing:

```bash
cd cli
npm run release:check
```

Customers do not need Python, this repository, TypeScript, or provider keys.
The production API is built into the client; browser approval remains on the
server-controlled `https://swico.in` origin.

## Login and sessions

`swico login` starts a short-lived proof-bound device request, prints a fixed
HTTPS Swico verification URL and human code, and opens the browser when
possible. The website requires an authenticated, verified account and an
explicit approval. The code is not a bearer credential. Tokens use the
platform credential store where available. On systems without one, choose
`SWICO_CLI_CREDENTIAL_FILE` as an explicit protected fallback or use
`--memory-only` deliberately; the CLI reports memory-only sessions instead of
claiming durable login.
The Node standard library has no dependency-free Windows Credential Manager
API; until a reviewed OS-store adapter is approved, Windows persistent login
requires the protected fallback rather than silently writing plaintext tokens.
Do not put it in a repository, service environment, or child-process
environment. Revoke sessions at `/settings/cli-sessions`.

## Chat and agent

`swico ask "question"` and the interactive client stream normal Chat replies.
`/model` and `/mode` display the selected public tier; they never accept a raw
vendor model. The local agent is bounded by the server-advertised step limit.
Before selected files or tool results leave the workstation, the client asks
for workspace trust. `list_files`, `search_text`, `read_file`, `apply_patch`
and `run_command` are confined to the canonical selected root. Secrets,
dependencies, build output, binaries, traversal and symlink escapes are
blocked. Every patch and command requires approval. Commands execute with the
user's permissions; this is not an OS sandbox.

Raw source, patches, prompts and command output are not stored in durable
Swico run records. Pending action metadata expires after 300 seconds. The
local action journal is separate and should be retained only as long as the
user needs to inspect or recover a run.

Typical use after installation:

```bash
swico login
swico
swico ask "Summarize the latest server history"
swico whoami
swico resume
swico logout
```

Interactive `/history` and `/resume` show server conversations; local action
journal entries are separate and contain hashes and status only. `/agent TASK`
requests workspace trust, then asks before every edit or command. `/diff`
shows the journal location. If login is unavailable, run `swico doctor`, check
the HTTPS endpoint override, and retry; the CLI never asks for a provider key.
A non-TTY invocation must use an explicit command such as `swico ask` and
exits nonzero when approval or authentication is required.

## Development endpoint

Set `SWICO_API_BASE_URL` to an explicit HTTPS development API origin. For localhost-only
development, set `SWICO_CLI_ALLOW_INSECURE_LOCAL=1`; never use that override in
production. `SWICO_CLI_CREDENTIAL_FILE` is intentionally not set by project
configuration.

## Publisher commands

After confirming that the publisher controls the `@swiveltechnologies` npm
scope and that
the repository's approved license is included in the release, run explicitly.
This checkout has no approved top-level LICENSE file, so the package allowlist
does not reference a missing file; publication remains gated on the project's
licensing decision rather than inventing terms here.

```bash
cd cli
npm ci
npm run build
npm test
npm run release:check -- --keep-artifact
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish ./swiveltechnologies-swico-0.1.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/
```

Use the artifact filename printed by `release:check` if the version changes.
`npm whoami` proves identity, not write access to `@swiveltechnologies`; inspect package
metadata after publication and then install the intended package from the
public registry in a clean prefix. On Windows use `npm.cmd` and `swico.cmd`
equivalents. Scope creation/joining and interactive publish authentication
belong to the publisher, not customers or Render.

For a reviewed local tarball, including transfer to a tester without the
repository, install the exact filename emitted by `npm pack --json`:

```bash
npm install -g ./swiveltechnologies-swico-0.1.0.tgz
```

This is not a public-registry install and does not make the package available
to customers.

The initial Chat release keeps `SWICO_CLI_AGENT_ENABLED=false`; agent release
gates are separate from package installation.
