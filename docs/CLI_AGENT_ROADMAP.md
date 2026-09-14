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
hook bus with executable hooks disabled, static shell completion, CLI search
mode/temporary image attachment fields, and bounded read-only model-backed
subagents. Each subagent is a separate short Chat round through the existing
server billing path; only bounded local observations are sent and the root
agent remains the sole mutating actor. These do not create a second provider
or billing path.

Stage 3 remains intentionally bounded: unattended mutating MCP tools, remote
plugin installation, executable hooks, image workflows requiring a new
server capability, and mutating/parallel worktree subagents remain deferred.
Each requires reviewed capability negotiation, owner-scoped billing, bounded
data flow, approval and cancellation semantics, and platform security tests.
Full-auto or dangerous modes are not planned until a real platform-enforced
sandbox exists on the target platform.

The production rollout remains `SWICO_CLI_AGENT_ENABLED=false` until the
 agent's provider budgeting, cancellation/recovery, and cross-platform local
side-effect gates are separately approved.

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
`swico worktree`; the primary tree is never stashed or reset. Mutating
parallel subagents and automatic merge are not enabled yet. Cloud commands
are wired to a fail-closed control-plane seam, but no isolated runner is
configured, so no repository code can execute in the API process.

The following remain later-stage work: a reviewed Windows sandbox, a verified
cross-platform hostile runtime, durable
isolated cloud runners and snapshot handoff, mutating subagents with merge
review, sandboxed executable hooks, and unattended side-effecting MCP.
