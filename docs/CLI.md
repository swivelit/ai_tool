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

The CLI is paid-only. If the website currently has Swico Free selected, choose
the CLI tier explicitly, for example with `swico login --tier lite`; use
`--tier standard` or `--tier pro` as separate alternatives when appropriate.
This is scoped to the CLI session and does not silently change the website
preference; the server rechecks Chat eligibility and wallet or subscription
allowance before each AI operation.

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
On a capable TTY, bare `swico` uses the default rich terminal UI: a compact
startup card, distinct user/Swico turns, incremental output, readable notices,
and a multiline composer. Enter submits; Ctrl+J inserts a newline and is the
portable fallback for terminals that cannot distinguish Shift+Enter. Bracketed
paste stays in the draft, slash suggestions come from the exact command
registry, and Ctrl+C cancels an active turn without an automatic retry. `Esc`
and `/exit` restore the terminal. Use `swico --plain`, a non-TTY, or
`TERM=dumb` for the line-oriented interface; `NO_COLOR` only disables color.
Machine output and MCP stdio remain on their existing non-rich paths.
At the macOS shell, `swico usage` prints a readable, read-only Chat wallet and
estimate summary; `swico usage --json` returns the stable public usage envelope
for scripts. Inside an interactive Swico session, use `/usage` instead. These
commands refresh the selected session when needed but never generate, upload,
create a reservation, or change tier. Token ranges are estimates and monetary
values remain integer micros.
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
output, timeouts, and process cleanup. When a reviewed OS runtime is
available, commands additionally run inside an OS-enforced sandbox: macOS
uses Seatbelt `sandbox-exec`, and Linux uses `bubblewrap`. The runtime probe
is not a security proof: `swico sandbox verify` runs hostile, disposable
probes for filesystem, network, environment, process, and symlink boundaries.
Agent execution requires those probes to pass. If the runtime is missing, the
host refuses policy application, or any probe fails, the CLI fails closed
rather than claiming isolation. Windows has no bundled supported runtime in
this release, so local agent execution is unavailable there until a reviewed
Windows implementation is selected. This is not a sandbox for the API
service.

Sandbox and approval are separate dimensions. User configuration may choose
`sandbox_policy = "read-only"` or `"workspace-write"`; project config can
only narrow to read-only. `approval_policy` is limited to `on-request` and
`always`, and there is no unsandboxed/full-auto setting. Network access is
disabled for local commands and stdio MCP processes, and child processes
receive only basic runtime variables rather than host credentials.

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

Interactive slash commands are exact-token commands. Unknown commands such as
`/exite`, `/usagex`, and `/searchlight` receive local usage feedback and do not
fall through to Chat; the same session remains usable. Use `/ask /literal text`
for deliberate slash-prefixed message text. `/exit` exits locally.

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

## Stage 2 local extensions

The CLI can read a user configuration at `~/.config/swico/config.toml` (or
the Windows per-user Swico config directory) and a project `.swico/config.toml`.
Project configuration is untrusted and can only narrow safe behavior. Use
`swico config show|path|validate` to inspect it; credentials and provider keys
never belong there.

`swico mcp add NAME COMMAND [ARGS...]`, `mcp list`, `mcp get NAME`, and
`mcp test NAME` support explicitly configured stdio MCP servers. HTTPS
Streamable HTTP servers can be configured with environment-variable header
references. Unknown or side-effecting calls require approval, credentials are
not sent to Swico, and project MCP entries are inspection-only. `swico
mcp-server` exposes only read-only repository status, file listing, and diff
over stdio. Legacy MCP SSE is not enabled in this release.

`swico skills list|show NAME` discovers bounded `SKILL.md` descriptions from
user/project locations; full instructions load only after selection.
`swico plugins` only validates local declarative `swico-plugin.json` files and
never executes plugin code. `swico completion bash|zsh|fish|powershell`
prints static scripts without network access. Hook events exist as an
in-process abstraction; executable hooks remain disabled because a reviewed
sandboxed hook runner is not available yet.
`--search`/`--no-search` and `/search auto|on|off` request server-controlled
web-search behavior, and `--image PATH`/`/image PATH` uses the existing
temporary, owner-scoped paid image upload policy; Free remains text-only.

Read-only subagents are bounded model-backed analysis rounds (maximum four,
depth one) through the authenticated, metered Chat path. They receive only
bounded local observations and cannot mutate the shared workspace. `swico worktree
create|list|clean` provides explicit Swico-owned detached Git worktrees for
future isolated work and never stashes or resets the primary tree. Mutating
subagents and automatic merge remain disabled. `swico sandbox
status|doctor|setup` reports runtime readiness; `swico sandbox verify [--json]`
is the explicit hostile-boundary check. Agent planning may request a bounded `web_search`
action; it returns through the authenticated shared Chat endpoint with
`search_mode=on`, so the backend remains authoritative for eligibility,
evidence, billing, and limits.

Cloud commands are explicit (`swico cloud exec|status|resume|cancel`). They
currently return `cloud_execution_unavailable`: no isolated runner or job
capability service is configured, and repository code is never executed in
the API process. There is no fallback to Render.

## Sandbox verification and platform support

The current adapter intentionally has no unsandboxed fallback. The macOS
adapter uses the system Seatbelt interface on both Intel and Apple Silicon;
the latest ordinary desktop readiness control on this Intel host ended with
`unknown_failure`/`SIGABRT`, so native enforcement remains unverified and
unavailable here. Linux uses system bubblewrap and requires usable
unprivileged user/mount namespaces. Windows is fail-closed: no reviewed
native filesystem/network runtime is bundled.

`swico sandbox verify` creates only temporary fake files, a local loopback
test server, and a fake environment secret. It never reads real credentials.
It must pass before a local agent can run. A successful `sandbox status` only
means that the system runtime's basic readiness probe succeeded; it does not
mean that the boundary is verified. Network-enabled commands are an explicit
separate policy and are not enabled by default.

## Publisher commands

After a fresh seven-check CI run has retained the stable artifact and its
manifest, confirming that the publisher controls the `@swiveltechnologies` npm
scope and that the repository's approved license is included in the release,
run explicitly against the downloaded canonical tarball.
The CLI package is scoped under the approved MIT terms in `cli/LICENSE` and
`cli/LICENSE_SCOPE.md`; this does not relicense the monorepo or grant hosted
service access. Publication remains a separate owner decision: confirm control
of the `@swiveltechnologies` npm scope and preserve the packaged license and
dependency notices. npm identity proves account identity, not scope write
permission.

```bash
cd cli
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish ./swiveltechnologies-swico-0.2.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/
```

These are conditional owner-operated commands only; this pass does not run
them. RC8 remains historical prerelease evidence. If a tester needs the RC8
pilot, its exact retained archive may be published separately with `--tag beta`
or an explicitly approved `next` tag, never `latest`:

```bash
npm install -g @swiveltechnologies/swico@beta
```

The stable workflow is the `0.2.0` build in this checkout, followed by a fresh
seven-check CI run (including canonical artifact retention). Publish only the
exact tarball and SHA-256 recorded by that run's release manifest with
`--tag latest`; only then should the unqualified command be used:

```bash
npm install -g @swiveltechnologies/swico
```

`npm whoami` proves npm identity, not write access to the
`@swiveltechnologies` scope. Check scope permissions with the authorized owner
before publishing. npm account identity is separate from Swico browser login:
downloading the package never grants API access, and server rollout/paid
eligibility still governs use. Use the exact artifact filename and hash emitted
by the final release check. On Windows use `npm.cmd` and `swico.cmd`
equivalents. Scope creation/joining and interactive publish authentication
belong to the owner, not customers or Render.

For a reviewed local tarball, including transfer to a tester without the
repository, install the exact filename emitted by `npm pack --json`:

```bash
npm install -g ./swiveltechnologies-swico-0.2.0.tgz
```

This is not a public-registry install and does not make the package available
to customers.

The initial Chat release keeps `SWICO_CLI_AGENT_ENABLED=false`; agent release
gates are separate from package installation.
