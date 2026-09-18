# Swico CLI agent roadmap

The first-generation local agent keeps the server as the authority for
authentication, tier eligibility, Chat billing, step ceilings, action hashes,
ownership, expiry, and cancellation. The workstation owns the repository
tools, approval prompts, process execution, and the local action journal.
Commands use the user's permissions inside the local OS sandbox only after
the runtime probe and hostile verification succeed; platform readiness is
reported and unsupported hosts fail closed. A runtime being installed is not
itself proof of isolation.

Implemented in the current release boundary:

- Chat, plan, and approval-required local-agent modes, with automatic routing
  of repository tasks in a Git workspace.
- bounded repository discovery, Git metadata, applicable `AGENTS.md` files,
  ripgrep search with a safe fallback, line ranges, unified hunks, create,
  delete, move, Git status, and Git diff.
- structured bounded context, visible local plan state, local resumable
  metadata, read-only/approval-required profiles, and non-interactive
  `exec` fail-closed behavior for agent mutations.

Stage 2 foundations now present in the CLI are deliberately bounded: local
TOML configuration (project files can only narrow behavior), an official MCP
SDK client for stdio and Streamable HTTP with explicit approval for unknown or
side-effecting tools, a read-only stdio `swico mcp-server`, description-first
SKILL.md discovery, declarative plugin inspection, an in-process lifecycle
  hook bus with sandbox-gated executable hooks, static shell completion, CLI search
mode/temporary image attachment fields, and bounded read-only model-backed
subagents. Each subagent is a separate short Chat round through the existing
server billing path; only bounded local observations are sent and the root
agent remains the sole mutating actor. These do not create a second provider
or billing path.

This implementation pass adds a persisted `workspace-write` profile (still
hard-gated by hostile sandbox proof), explicit hash-bound executable plugin
trust, sandbox-gated executable hooks, a review-first mutating worktree
coordinator, bounded workspace mention search, local history search, clipboard
copy, and a durable cloud control-plane job/event API. Unattended mutating MCP
tools, remote plugin installation, automatic worker merge, and provider-backed
cloud execution remain deferred.
Each requires reviewed capability negotiation, owner-scoped billing, bounded
data flow, approval and cancellation semantics, and platform security tests.
Full-auto or dangerous modes are not planned until a real platform-enforced
sandbox exists on the target platform.

The production public Chat rollout remains `SWICO_CLI_AGENT_ENABLED=false`.
The dedicated Linux hostile-isolation workflow now provides native bubblewrap
evidence. The remaining promotion gate is the installed-artifact harness in
`cli/scripts/accept-installed-agent.mjs`; it must be run on the same Linux
platform against the canonical tarball and must produce current evidence for
the bounded coding loop and exactly-once settlement. Only after both gates
pass may an agent pilot use:

```dotenv
SWICO_CLI_ENABLED=true
SWICO_CLI_ALLOWED_EMAILS=
SWICO_CLI_AGENT_ENABLED=true
SWICO_CLI_AGENT_ALLOWED_EMAILS=<comma-separated verified tester emails>
SWICO_CLI_CLOUD_AGENT_ENABLED=false
SWICO_CLI_WEB_ORIGIN=https://swico.in
```

The agent allowlist is independent of public CLI access and weekly tester
credits. Missing, empty, or whitespace-only `SWICO_CLI_AGENT_ALLOWED_EMAILS`
denies every local-agent and Cloud pilot admission when the agent flag is
enabled. Public Chat has the separate `SWICO_CLI_ALLOWED_EMAILS` setting,
which may intentionally be empty for public paid rollout.

## Stage 3 security boundary in this checkout

The local command path now has a dedicated `SandboxAdapter`. On macOS it
uses the OS Seatbelt runtime when a probe confirms that policies can be
applied; on Linux it uses `bubblewrap` when installed and usable. Windows is
fail-closed because this checkout does not bundle a reviewed native runtime.
`swico sandbox verify` executes disposable hostile probes for workspace and
outside filesystem access, fake home secrets, environment stripping, network
isolation, child-process inheritance, and symlink escapes. Agent execution
requires that proof. Read-only and workspace-write sandbox policies are
separate from the existing approval profile. Network is disabled by default
and child environments are reduced to basic runtime variables. Stage 3 does
not claim an OS sandbox for the API service.

Explicit Swico-owned detached Git worktrees are available through
`swico worktree`; the primary tree is never stashed or reset. The new
mutating-worker coordinator gives each worker an owned detached worktree and
requires review plus a clean-primary check before apply. Cloud jobs are
persisted and owner-scoped, but no runner executor is configured, so no
repository code can execute in the API process.

The following remain later-stage work: a reviewed Windows sandbox, a verified
cross-platform hostile runtime, runner-native execution and snapshot transfer,
provider-backed worker execution, and unattended side-effecting MCP.
