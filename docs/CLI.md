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
claiming durable login. Normal supported desktop installations use the native
OS store supplied by `@napi-rs/keyring`: macOS Keychain, Windows Credential
Manager, or Linux Secret Service. Its supported packages contain prebuilt
bindings, so users do not need Rust or a compiler. If a native store is
unavailable, the CLI fails closed; use the explicit protected-file fallback or
`--memory-only` rather than silently writing plaintext tokens. Do not put
credentials in a repository, service environment, or child-process
environment. Revoke sessions at `/settings/cli-sessions`.

## Chat and agent

`swico ask "question"` and the interactive client stream normal Chat replies.
`/model` displays the selected public tier and never accepts a raw vendor
model. Interactive repository tasks are routed to the local agent when the
mode is `auto`; `/mode chat`, `/mode plan`, and `/mode agent` select an
explicit mode. `/mode` displays the current mode. Plan mode only inspects the
workspace and produces a plan. Agent mode is bounded by the server-advertised
step limit and asks before every edit or command.
Before selected files or tool results leave the workstation, the client asks
for workspace trust. The local tools are `list_files`, `search_text`,
`read_file`, `read_file_range`, `apply_patch`, `create_file`, `delete_file`,
`move_file`, `run_command`, `git_status`, and `git_diff`. They are confined to
the canonical selected root. Secrets, dependencies, build output, binaries,
traversal and symlink escapes are blocked. Patches use base hashes and
unified hunks, are previewed, rechecked immediately before atomic writes, and
preserve file modes. Commands use explicit argv with `shell=false`, bounded
output, timeouts, and process cleanup. Commands execute with the user's
permissions; this is not an OS sandbox.

`/status` shows the repository, branch, dirty state, mode, permission profile,
agent scope, applicable instruction files, and bounded-context state.
`/permissions` selects `read-only` or `approval-required`; the former blocks
commands and mutations. `/plan` shows a concise plan, `/init` creates a
starter `AGENTS.md` only after approval, `/review` reviews the current Git
diff without editing, and `/resume` shows then continues safe local
coding-session metadata when its server run is still resumable.
`swico exec "task" --mode chat|plan|agent` is available for scripts; agent
execution fails closed when approval is needed. `--json`, `--output`, and
`--output-schema` are supported for non-interactive Chat/plan workflows.

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

Interactive `/history` shows server conversations; `/resume` is for local
coding runs. Local action journal entries are separate and contain hashes and
status only. `/agent TASK`
requests workspace trust, then asks before every edit or command. `/diff`
shows a bounded Git diff. If login is unavailable, run `swico doctor`, check
the HTTPS endpoint override, and retry; the CLI never asks for a provider key.
A non-TTY invocation must use an explicit command such as `swico ask` or
`swico exec`; it exits nonzero when authentication or local approval is
required. `/diff` displays a bounded Git diff. Ctrl-C cancels the active Chat request where supported and cancels
the server agent run while stopping an approved local command.

Repository instructions are loaded from the Git root toward the working
directory. Nearest `AGENTS.md` content is presented last, within a bounded
total size, and is treated as untrusted context rather than executable policy.
No raw source, command output, patch body, or credentials are written to
durable server run records. The local journal stores action hashes and status.
See [the agent roadmap](CLI_AGENT_ROADMAP.md) for deliberately deferred
capabilities.

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
