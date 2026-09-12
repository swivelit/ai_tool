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

Stage 2/3 work remains intentionally out of scope: MCP, skills/plugins,
hooks, image input, web search, subagents, worktrees, cloud execution or
handoff, and an OS-enforced sandbox. Each requires a reviewed protocol,
explicit capability negotiation, owner-scoped billing, bounded data flow,
approval and cancellation semantics, and platform security tests before it
can be enabled. Full-auto or dangerous modes are not planned until a real
platform-enforced sandbox exists.

The production rollout remains `SWICO_CLI_AGENT_ENABLED=false` until the
agent's provider budgeting, cancellation/recovery, and cross-platform local
side-effect gates are separately approved.
