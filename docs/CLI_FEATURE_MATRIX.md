# Swico CLI feature matrix

This is the release-readiness status of the current checkout. “Verified”
means covered by local tests and checks; it does not mean a live provider,
production browser, native-device, or every OS security boundary was tested.

| Capability | Status | Boundary / evidence |
|---|---|---|
| Authentication and device approval | IMPLEMENTED + VERIFIED | Proof-bound device flow, rotation, revocation tests |
| Native credential persistence | IMPLEMENTED + VERIFIED | Keyring adapter and macOS persistence verified; platform CI still required |
| Chat, streaming, billing, tiers | IMPLEMENTED + VERIFIED | Shared CLI Chat route and focused backend/client tests |
| Repository discovery and Git status/diff | IMPLEMENTED + VERIFIED | Local repository tests |
| AGENTS.md instructions | IMPLEMENTED + VERIFIED | Bounded, nearest-directory precedence and symlink checks |
| Read, search, ranges | IMPLEMENTED + VERIFIED | ripgrep/fallback and path confinement tests |
| Patch, create/delete/move | IMPLEMENTED + VERIFIED | Approval, hash and atomic workspace tests |
| Commands and cancellation | IMPLEMENTED + VERIFIED | Explicit approval, bounded output and cleanup tests |
| Permission profiles | IMPLEMENTED + VERIFIED | Read-only and approval-required behavior |
| Plans and context compaction | IMPLEMENTED + VERIFIED | Bounded local metadata/context tests |
| Resume and review | IMPLEMENTED + VERIFIED | Owner/workspace checks and read-only review |
| Non-interactive exec | IMPLEMENTED + VERIFIED | Agent mutations fail closed without approval |
| MCP stdio | PARTIAL | SDK transport and sandbox gate; host sandbox is unavailable here |
| MCP HTTP | PARTIAL | Streamable HTTPS transport; broader hostile-server coverage remains |
| Swico MCP server | IMPLEMENTED + VERIFIED | Read-only stdio capabilities only |
| Skills and declarative plugins | IMPLEMENTED + VERIFIED | Bounded discovery/inspection; no executable plugins |
| Hooks | FAIL-CLOSED / DISABLED | Event bus exists; executable hooks remain disabled |
| Images | PARTIAL | CLI upload reuses temporary paid image path; live/device verification pending |
| Web search | IMPLEMENTED + UNVERIFIED | Server-controlled evidence path; no live provider calls in this audit |
| Read-only subagents | IMPLEMENTED + UNVERIFIED | Up to 4 depth-one server Chat rounds, shared billing; no live provider test |
| macOS sandbox | FAIL-CLOSED / DISABLED | Runtime diagnostic and hostile verification are present; this Intel host refuses sandbox_apply |
| Linux sandbox | IMPLEMENTED + UNVERIFIED | bubblewrap plus hostile verification; no real Linux host was available in this audit |
| Windows sandbox | FAIL-CLOSED / DISABLED | No reviewed native runtime bundled |
| Network isolation | IMPLEMENTED + UNVERIFIED | OS adapter policy plus real loopback probe; hostile runtime proof pending |
| Secret environment isolation | IMPLEMENTED + UNVERIFIED | Cleared/minimal child environment plus fake-secret probe; cross-platform proof pending |
| Worktrees | IMPLEMENTED + VERIFIED | Owned detached worktrees preserve dirty primary tree |
| Mutating subagents | NOT IMPLEMENTED | No shared-tree mutation or automatic merge |
| Cloud execution | FAIL-CLOSED / DISABLED | No isolated runner; API never executes repository code |
| Shell completion | IMPLEMENTED + VERIFIED | All four shells use one command definition |
| Doctor/readiness | IMPLEMENTED + VERIFIED | No-cost public health endpoint and offline diagnostics |
| npm package | IMPLEMENTED + VERIFIED | Packed artifact inspected locally; not published |
| License | FAIL-CLOSED / DISABLED | No approved top-level LICENSE; publication decision required |

`swico sandbox verify --json` is the authoritative local hostile-boundary
check. `swico release-readiness --json` reports `agent_sandbox_ready` as
blocked until that check passes; it does not make cloud readiness a local
agent blocker. On the current Intel macOS host the verification probes are
correctly not run because `sandbox_apply` is refused.

The initial production controls remain `SWICO_CLI_AGENT_ENABLED=false` and
`SWICO_CLI_CLOUD_AGENT_ENABLED=false`.
