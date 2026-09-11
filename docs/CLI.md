# Swico CLI

Swico CLI is a third client for existing Swico accounts. It uses the account's
Chat subscription or wallet and receives only public tier labels. Provider
names, provider keys and internal model identifiers are never CLI inputs.
Swico Free retains its existing eligibility and local-only inference rules.

## Rollout and installation

From the repository root while developing:

```bash
npm --prefix cli ci
npm --prefix cli run build
npm --prefix cli link
swico --help
```

The package can be packed without publishing:

```bash
cd cli
npm pack --dry-run
npm pack
npm install --global ./swiveltechnologies-swico-0.1.0.tgz
```

Customers do not need Python, this repository, or provider keys. A future
public release requires verification that `@swiveltechnologies` is owned:
`npm login`, `npm publish --access public` from a reviewed package, and then
the normal release announcement. This repository does not publish it.

## Login and sessions

`swico login` starts a short-lived proof-bound device request, prints a fixed
HTTPS Swico verification URL and human code, and opens the browser when
possible. The website requires an authenticated, verified account and an
explicit approval. The code is not a bearer credential. Tokens are kept in
memory by default; an explicit `SWICO_CLI_CREDENTIAL_FILE` is a protected-file
fallback for environments without a keychain and must be chosen by the user.
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

Set `SWICO_API_BASE_URL` to an explicit HTTPS API origin. For localhost-only
development, set `SWICO_CLI_ALLOW_INSECURE_LOCAL=1`; never use that override in
production. `SWICO_CLI_CREDENTIAL_FILE` is intentionally not set by project
configuration.
