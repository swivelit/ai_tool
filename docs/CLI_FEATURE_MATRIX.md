# Swico CLI feature matrix

This is the release-readiness status of the current checkout. “Verified”
means covered by local tests and checks; it does not mean a live provider,
production browser, native-device, or every OS security boundary was tested.

## Dated parity baseline

Reviewed 2026-09-15 against the current official Codex CLI feature,
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
| Interactive editing and steering | PARTIAL | Multiline Unicode editing, paste, cancellation and ordered queued follow-ups are implemented; steering is owner/turn/sequence bound and consumed at a safe between-step checkpoint, but no provider-native stream mutation is claimed |
| Repository instructions, planning, local edits | IMPLEMENTED + UNVERIFIED | Disposable coding-loop acceptance covers discovery, AGENTS.md, hash-bound approval, atomic edits, bounded test/repair, and Git result reporting; native sandbox proof remains host-specific |
| Plans and approval loops | IMPLEMENTED + UNVERIFIED | Task-only plans and explicit approvals are tested; the deterministic disposable lifecycle is covered, but native hostile sandbox evidence is required per host |
| Approvals and local permissions | IMPLEMENTED + UNVERIFIED | Read-only, approval-required, and workspace-write are persisted; workspace-write is usable only after hostile sandbox proof |
| Skills, declarative plugins, hooks | IMPLEMENTED + UNVERIFIED | Skills plus explicit hash-bound executable-plugin trust and sandbox-gated hooks; project code is never trusted merely by existing |
| MCP | PARTIAL | Explicit stdio/HTTPS configuration; local stdio needs verified sandbox |
| Review, exec, completion | IMPLEMENTED + VERIFIED | Read-only review and bounded command paths; schema/agent automation remains limited |
| Sessions, resume, worktrees | PARTIAL | Owner-scoped metadata and detached worktrees; no automatic merge |
| Images and web search | IMPLEMENTED + UNVERIFIED | Server-controlled paid capabilities; live/device acceptance still pending |
| Model-backed subagents | IMPLEMENTED + UNVERIFIED | Read-only, bounded, depth-one workers through shared Chat billing |
| Sandboxed local execution | FAIL-CLOSED / DISABLED | Current macOS progressive diagnostic is denied by the host before policy execution; hostile enforcement is not accepted; Linux/Windows not proven here |
| Cloud tasks | IMPLEMENTED + UNVERIFIED | Durable owner-scoped control-plane jobs/events exist; execution remains disabled without a verified isolated runner |

The comparison follows the current official Codex CLI feature, reference, and
security pages linked above. Those pages describe the broader interactive
editing/steering, approvals and sandbox controls, repository instructions,
plans, MCP, skills/plugins, subagents/worktrees, non-interactive execution and
cloud surfaces. Swico's rows intentionally distinguish implemented code from
native, live-provider, billing, or hosted-runner acceptance; public Swico tiers
and server-owned routing remain unchanged.

Next bounded coding milestone: on a genuinely verified host, run one
disposable repository through inspect → plan → hash-bound approved edit →
sandboxed test → repair → diff/result, then exercise cancellation/resume and
request-correlated usage settlement. This is the next acceptance task, not a
request to add cloud runners, executable plugins, mutating parallel agents, or
weakened sandbox policy in RC8.

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
| Permission profiles | IMPLEMENTED + UNVERIFIED | Read-only, approval-required, and persisted workspace-write; workspace-write requires hostile sandbox proof |
| Plans and context compaction | IMPLEMENTED + VERIFIED | Task-only noninteractive plans; repository context requires explicit workspace consent |
| Resume and review | IMPLEMENTED + VERIFIED | Owner/workspace checks and read-only review |
| Non-interactive exec | IMPLEMENTED + VERIFIED | Agent mutations fail closed without approval |
| MCP stdio | PARTIAL | SDK transport and sandbox gate; host sandbox is unavailable here |
| MCP HTTP | PARTIAL | Streamable HTTPS transport; broader hostile-server coverage remains |
| Swico MCP server | IMPLEMENTED + VERIFIED | Read-only stdio capabilities only |
| Skills and declarative plugins | IMPLEMENTED + UNVERIFIED | Bounded discovery plus explicit hash-bound executable-plugin trust; repository plugins are never trusted merely by existing |
| Hooks | IMPLEMENTED + UNVERIFIED | Executable hooks require explicit trust, current hash, verified sandbox, bounded environment/output, and timeout |
| Images | PARTIAL | CLI upload reuses temporary paid image path; live/device verification pending |
| Web search | IMPLEMENTED + UNVERIFIED | Server-controlled evidence path; no live provider calls in this audit |
| Read-only subagents | IMPLEMENTED + UNVERIFIED | Up to 4 depth-one server Chat rounds, shared billing; bounded run reservation/rechecks; no live provider test |
| macOS sandbox | FAIL-CLOSED / DISABLED | Runtime diagnostic and progressive profile harness are present; current Intel host denies sandbox application before hostile probes, so native enforcement remains unverified |
| Linux sandbox | IMPLEMENTED + UNVERIFIED | bubblewrap plus hostile verification; no real Linux host was available in this audit |
| Windows sandbox | FAIL-CLOSED / DISABLED | No reviewed native runtime bundled |
| Network isolation | IMPLEMENTED + UNVERIFIED | OS adapter policy plus real loopback probe; hostile runtime proof pending |
| Secret environment isolation | IMPLEMENTED + UNVERIFIED | Cleared/minimal child environment plus fake-secret probe; cross-platform proof pending |
| Worktrees | IMPLEMENTED + VERIFIED | Owned detached worktrees preserve dirty primary tree |
| Mutating subagents | IMPLEMENTED + UNVERIFIED | Review-first coordinator uses an owned detached worktree and clean-primary apply; no automatic merge |
| Cloud control plane | IMPLEMENTED + UNVERIFIED | Durable owner-scoped jobs, idempotency, cancellation, and bounded lifecycle events; no API-local execution |
| Cloud execution | IMPLEMENTED + UNVERIFIED | Durable API queue, explicit byte snapshot endpoint, separate controller, capability-checked runner endpoint, and opt-in E2B execution path exist; live E2B/native hostile acceptance, durable billing reconciliation, and production attestation are not verified, so cloud remains disabled |
| Shell completion | IMPLEMENTED + VERIFIED | All four shells use one command definition |
| Doctor/readiness | IMPLEMENTED + VERIFIED (offline) | Chat, local-agent sandbox, local-agent end-to-end, and optional cloud states are reported separately; live/auth readiness remains unverified |
| npm package | IMPLEMENTED + VERIFIED | Published `@swiveltechnologies/swico@0.2.5` from the canonical CI artifact with provenance; earlier RC evidence remains historical |
| License | IMPLEMENTED + VERIFIED (package scope) | CLI-only MIT text, scope note, and dependency notice index are packaged; this does not relicense the monorepo or authorize publication |
| Queue and shell shorthand | IMPLEMENTED + UNVERIFIED | Bounded follow-up queue plus `!command` approval/sandbox path; native sandbox evidence remains host-specific |
| File mentions and local copy/history | IMPLEMENTED + VERIFIED | Bounded confined `/mention`, Ctrl+R local prompt search, Ctrl+O and `/copy` clipboard path |

`swico sandbox verify --json` is the authoritative local hostile-boundary
check. `swico release-readiness --json` reports `agent_sandbox_ready` as
blocked until that check passes; it does not make cloud readiness a local
agent blocker. On the current Intel macOS host the verification probes are
correctly not run because the latest ordinary desktop readiness control is
inconclusive because the host denied sandbox application before policy execution. This is not evidence of native
enforcement and does not change the fail-closed agent decision.

The public Chat release keeps `SWICO_CLI_AGENT_ENABLED=false` and
`SWICO_CLI_CLOUD_AGENT_ENABLED=false`. A future agent pilot additionally uses
`SWICO_CLI_AGENT_ALLOWED_EMAILS` as a case-insensitive server-owned verified
email restriction; it does not change public Chat access or weekly tester
credits.
