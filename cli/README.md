# @swiveltechnologies/swico

Swico CLI is a third client for existing Swico accounts. The terminal client
uses the existing Swico account and Chat billing bucket.
It does not accept provider keys or expose provider/model identifiers. The
server selects the public tier and enforces its normal quota and reservation
rules.

## Install

Customers do not need an npm account to download the public package:

```sh
npm install -g @swiveltechnologies/swico
swico login
swico
swico usage
```

The CLI is paid-only. If the website currently has Swico Free selected, choose
the CLI tier explicitly during authorization, for example `swico login
--tier lite`. Choose `--tier standard` or `--tier pro` as separate alternatives
when appropriate. This does not change the website preference; the server rechecks Chat eligibility and available wallet or
subscription allowance for every request.

The production API is built in as `https://ai-tool-rrau.onrender.com`; browser
approval remains on the server-controlled `https://swico.in` origin. Customers
do not need Python, this repository, TypeScript, or provider keys.

An earlier unavailable scope was `@swico/swico`. Remove only that old package
before installing the official scope so both packages do not compete for
`swico`; this does not remove Swico credentials:

```sh
npm uninstall -g @swico/swico
npm install -g @swiveltechnologies/swico
```

On Windows use `npm.cmd` and `swico.cmd` where command shims require them.

## Development

```sh
npm --prefix cli ci
npm --prefix cli run build
npm --prefix cli link
swico --help
```

For a local release artifact without publishing or an AI request, run:

```sh
cd cli
npm run release:check
```

It derives the tarball filename from `npm pack --json`, verifies the manifest
and compiled entrypoint, prints a SHA-256, and installs it into a clean
temporary npm prefix before running help/version/doctor outside this checkout.
Pass `--keep-artifact` when an operator needs the checked tarball for a later
publish command; the default check removes its temporary artifact.

Set `SWICO_API_BASE_URL` only for an approved HTTPS development endpoint.
Production endpoints must use HTTPS. On supported desktop installations,
credentials use the native OS store through `@napi-rs/keyring`: macOS
Keychain, Windows Credential Manager, or Linux Secret Service. The package
ships prebuilt native bindings for supported Node/OS/architecture triples, so
Rust is not required for an ordinary installation. If the native store is
unavailable, the CLI fails closed; choose the explicit protected-file fallback
`SWICO_CLI_CREDENTIAL_FILE` or the deliberately non-persistent `--memory-only`
mode. These choices are reported accurately and are never made implicitly.

`swico login` opens `/cli/authorize`, displays a short-lived human code, and
polls at the server-advertised interval. Browser approval is explicit.

Inside an interactive repository, `swico` automatically routes coding-shaped
requests to the bounded local agent after workspace trust and, when needed,
an explicit browser approval for the additional `agent` scope. Use `/mode`
to select `chat`, `plan`, or `agent`; `/status`, `/plan`, `/permissions`, and
`/review` expose the local workflow state. Commands and edits always require
approval. Agent commands require the OS-enforced sandbox verification described
below; there is no unsandboxed fallback. Production keeps `SWICO_CLI_AGENT_ENABLED=false` until its separate
rollout gates pass.

The bounded agent asks for workspace trust before sending selected content to
Swico, requires approval for every edit/command, confines files to the chosen
root, rejects secrets/symlinks/binaries, and uses an OS-enforced sandbox only
after `swico sandbox verify` passes. It is not a full Codex replacement. If
verification fails, agent execution is refused rather than falling back to
unsandboxed commands.

The initial public Chat release keeps `SWICO_CLI_AGENT_ENABLED=false` until
native sandbox verification, PostgreSQL lifecycle coverage, and the remaining
cancellation/recovery and local-side-effect acceptance gates are verified.
Durable planner/action reservations and exact-once replay handling are covered
by focused route tests. `swico login --agent` requests the additional scope
but does not bypass the server gate or tier eligibility.

Usage has two contexts: at the macOS shell, run `swico usage` or
`swico usage --json`; inside an already-running Swico session, enter `/usage`.
Both call the same read-only, refresh-aware `/usage` endpoint and never start
generation or change the selected tier. Monetary values remain integer micros;
token ranges are estimates, not exact provider-token balances. Use `/ask TEXT`
inside Swico when an intentional message begins with `/`; `swico ask
"/literal text"` is the shell form.

`swico release-readiness` runs local, non-charging readiness checks;
`swico release-readiness --json` returns the same report for automation. A
valid report may exit nonzero when the local-agent sandbox or package-license
gate is blocked; that is a readiness result, not a command-syntax failure.

On a capable interactive TTY, bare `swico` opens the default rich terminal
screen: a compact startup card, readable user/Swico turns, incremental Chat
output, notices, and a multiline composer. Enter submits, Ctrl+J inserts a
newline, and bracketed/multiline paste remains a draft until Enter. Shift+Enter
is recognized when the terminal reports a distinguishable modified-enter
sequence; Ctrl+J is the portable fallback. Arrow keys edit and browse history,
Tab selects a filtered slash-command suggestion, Page Up/Page Down scrolls the
conversation, and Ctrl+C cancels the active turn without retrying it. `/help`
shows the exact local command registry. The UI restores terminal state on
`/exit`, EOF, cancellation, errors, and signals. Use `swico --plain` or a
non-TTY/`TERM=dumb` environment for line-oriented output; `NO_COLOR` disables
color without changing the protocol. Machine JSON/JSONL and MCP stdio never
use the rich screen or mix diagnostics into stdout.

## Stage 2 local extensions

`swico config show|path|validate` reads the user TOML configuration and the
untrusted project `.swico/config.toml`; project settings can only narrow
behavior. `swico mcp list|get|add|remove|test` manages explicit local MCP
servers using the maintained MCP SDK. stdio and HTTPS Streamable HTTP are
supported, with bounded discovery/results and approval for unknown or
side-effecting tools. `swico mcp-server` is a read-only stdio server for
status, file listing and diff; it exposes no mutation tools before Stage 3.

`swico skills list|show`, `swico plugins list|inspect`, and static
`swico completion bash|zsh|fish|powershell` are available without network
requests. Skills are untrusted, description-first `SKILL.md` files; plugins
are declarative manifests only and are never executed. `/search auto|on|off`
selects a server-controlled search policy and `--image PATH` uploads a
bounded, owner-scoped temporary image for paid Chat/vision flows. Free stays
text-only. Read-only subagents are bounded server Chat analysis rounds (four
maximum, depth one) using the shared authenticated billing path; they receive
only bounded local observations and cannot mutate the workspace. Parallel
subagents, executable hooks,
remote plugins and mutating MCP remain deferred. Local agent commands use an
OS-enforced sandbox only when the platform runtime is available and the
hostile verification passes; otherwise the agent fails closed. Use `swico
sandbox status` for runtime diagnostics and `swico sandbox verify` for the
actual boundary check.

## License

The first-party Swico CLI client is MIT-licensed. See `LICENSE`,
`LICENSE_SCOPE.md`, and `THIRD_PARTY_NOTICES.md`. This does not license the
backend, website, or Android application, or grant free hosted-service access.
Third-party code keeps its own licenses and notices.
