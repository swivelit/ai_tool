# Swico CLI feature matrix

This is the release-readiness status of the current checkout. “Verified”
means covered by local tests and checks; it does not mean a live provider,
production browser, native-device, or every OS security boundary was tested.

## Dated parity baseline

Reviewed 2026-09-13 against the current official Codex CLI feature,
reference, and security documentation:

- https://developers.openai.com/codex/cli/features
- https://developers.openai.com/codex/cli/reference
- https://developers.openai.com/codex/security

This is a capability comparison, not a claim of Codex parity. Swico keeps
server-owned public tiers and shared Swico billing instead of exposing vendor
model selectors. Stable Codex workflows that Swico implements are listed
below; beta/experimental or infrastructure-dependent workflows remain
explicitly bounded.

| Workflow area | Swico status | Current boundary |
|---|---|---|
| Terminal chat, streaming, history | IMPLEMENTED + VERIFIED | Shared authenticated Chat route plus installed rich/plain terminal paths; no new live-provider call in this check |
| Repository instructions, planning, local edits | PARTIAL | Bounded agent protocol; local agent blocked unless hostile sandbox proof passes |
| Approvals and local permissions | IMPLEMENTED + VERIFIED | Read-only/approval-required only; no full-auto mode |
| Skills, declarative plugins, hooks | PARTIAL | Skills and inspection work; executable hooks/plugins remain disabled |
| MCP | PARTIAL | Explicit stdio/HTTPS configuration; local stdio needs verified sandbox |
| Review, exec, completion | IMPLEMENTED + VERIFIED | Read-only review and bounded command paths; schema/agent automation remains limited |
| Sessions, resume, worktrees | PARTIAL | Owner-scoped metadata and detached worktrees; no automatic merge |
| Images and web search | IMPLEMENTED + UNVERIFIED | Server-controlled paid capabilities; live/device acceptance still pending |
| Model-backed subagents | IMPLEMENTED + UNVERIFIED | Read-only, bounded, depth-one workers through shared Chat billing |
| Sandboxed local execution | FAIL-CLOSED / DISABLED | Latest ordinary macOS desktop diagnostic ends in `unknown_failure`/`SIGABRT`; hostile enforcement is not accepted; Linux/Windows not proven here |
| Cloud tasks | FAIL-CLOSED / DISABLED | No isolated runner; API never executes repository code |

| Capability | Status | Boundary / evidence |
|---|---|---|
| Authentication and device approval | IMPLEMENTED + VERIFIED | Proof-bound device flow, rotation, revocation tests |
| Native credential persistence | IMPLEMENTED + UNVERIFIED | Credential protocol and fake-store lifecycle are tested; native keyring save/load/delete acceptance is not run |
| Chat, streaming, billing, tiers | IMPLEMENTED + VERIFIED | Shared CLI Chat route and focused backend/client tests |
| Repository discovery and Git status/diff | IMPLEMENTED + VERIFIED | Local repository tests |
| AGENTS.md instructions | IMPLEMENTED + VERIFIED | Bounded, nearest-directory precedence and symlink checks |
| Read, search, ranges | IMPLEMENTED + VERIFIED | ripgrep/fallback and path confinement tests |
| Patch, create/delete/move | IMPLEMENTED + VERIFIED | Approval, hash and atomic workspace tests |
| Commands and cancellation | IMPLEMENTED + VERIFIED | Explicit approval, bounded output and cleanup tests |
| Permission profiles | IMPLEMENTED + VERIFIED | Read-only and approval-required behavior |
| Plans and context compaction | IMPLEMENTED + VERIFIED | Task-only noninteractive plans; repository context requires explicit workspace consent |
| Resume and review | IMPLEMENTED + VERIFIED | Owner/workspace checks and read-only review |
| Non-interactive exec | IMPLEMENTED + VERIFIED | Agent mutations fail closed without approval |
| MCP stdio | PARTIAL | SDK transport and sandbox gate; host sandbox is unavailable here |
| MCP HTTP | PARTIAL | Streamable HTTPS transport; broader hostile-server coverage remains |
| Swico MCP server | IMPLEMENTED + VERIFIED | Read-only stdio capabilities only |
| Skills and declarative plugins | IMPLEMENTED + VERIFIED | Bounded discovery/inspection; no executable plugins |
| Hooks | FAIL-CLOSED / DISABLED | Event bus exists; executable hooks remain disabled |
| Images | PARTIAL | CLI upload reuses temporary paid image path; live/device verification pending |
| Web search | IMPLEMENTED + UNVERIFIED | Server-controlled evidence path; no live provider calls in this audit |
| Read-only subagents | IMPLEMENTED + UNVERIFIED | Up to 4 depth-one server Chat rounds, shared billing; bounded run reservation/rechecks; no live provider test |
| macOS sandbox | FAIL-CLOSED / DISABLED | Runtime diagnostic and hostile verification are present; latest ordinary desktop readiness control reports `unknown_failure`/`SIGABRT`, so native enforcement remains unverified |
| Linux sandbox | IMPLEMENTED + UNVERIFIED | bubblewrap plus hostile verification; no real Linux host was available in this audit |
| Windows sandbox | FAIL-CLOSED / DISABLED | No reviewed native runtime bundled |
| Network isolation | IMPLEMENTED + UNVERIFIED | OS adapter policy plus real loopback probe; hostile runtime proof pending |
| Secret environment isolation | IMPLEMENTED + UNVERIFIED | Cleared/minimal child environment plus fake-secret probe; cross-platform proof pending |
| Worktrees | IMPLEMENTED + VERIFIED | Owned detached worktrees preserve dirty primary tree |
| Mutating subagents | NOT IMPLEMENTED | No shared-tree mutation or automatic merge |
| Cloud execution | FAIL-CLOSED / DISABLED | No isolated runner; API never executes repository code |
| Shell completion | IMPLEMENTED + VERIFIED | All four shells use one command definition |
| Doctor/readiness | IMPLEMENTED + VERIFIED (offline) | No-cost public health endpoint and truly offline credential diagnostics; live/auth readiness remains unverified |
| npm package | IMPLEMENTED + VERIFIED (installed path) | `0.2.0-rc.4` candidate is tested locally against controlled API/PTY; Windows ConPTY and remote CI evidence are recorded separately; not published until owner approval |
| License | IMPLEMENTED + VERIFIED (package scope) | CLI-only MIT text, scope note, and dependency notice index are packaged; this does not relicense the monorepo or authorize publication |

`swico sandbox verify --json` is the authoritative local hostile-boundary
check. `swico release-readiness --json` reports `agent_sandbox_ready` as
blocked until that check passes; it does not make cloud readiness a local
agent blocker. On the current Intel macOS host the verification probes are
correctly not run because the latest ordinary desktop readiness control is
inconclusive (`unknown_failure`/`SIGABRT`). This is not evidence of native
enforcement and does not change the fail-closed agent decision.

The initial production controls remain `SWICO_CLI_AGENT_ENABLED=false` and
`SWICO_CLI_CLOUD_AGENT_ENABLED=false`.
