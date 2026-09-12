# Swico CLI agent roadmap

The first-generation local agent keeps the server as the authority for
authentication, tier eligibility, Chat billing, step ceilings, action hashes,
ownership, expiry, and cancellation. The workstation owns the repository
tools, approval prompts, process execution, and the local action journal.
Commands run with the user's permissions; the current implementation is not
an OS sandbox.

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
mode/temporary image attachment fields, and bounded read-only subagent
inspection. These do not create a second provider or billing path.

Stage 3 remains intentionally deferred: sandboxing, unattended mutating MCP
tools, worktrees, cloud execution/handoff, remote plugin installation,
executable hooks, image workflows requiring a new server capability, and
provider-backed parallel subagents. Each requires reviewed capability
negotiation, owner-scoped billing, bounded data flow, approval and
cancellation semantics, and platform security tests. Full-auto or dangerous
modes are not planned until a real platform-enforced sandbox exists.

The production rollout remains `SWICO_CLI_AGENT_ENABLED=false` until the
agent's provider budgeting, cancellation/recovery, and cross-platform local
side-effect gates are separately approved.
