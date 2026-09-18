# Swico CLI sandbox assessment

This is an implementation and release boundary document, not a claim that
all desktop platforms are ready. Swico has no unsandboxed agent fallback.

## Evaluated runtimes

* macOS Seatbelt (`sandbox-exec`) is a system primitive available on Intel
  and Apple Silicon. The current 0.2.6 progressive diagnostic on this Intel
  development host reports a policy-level denial for the deny-default control
  and `SIGABRT` for later runtime profiles. The shipped diagnostic now keeps
  those outcomes distinct; generated profiles still do not reach hostile
  verification, so macOS remains fail-closed here.
* [Bubblewrap](https://github.com/containers/bubblewrap) is an actively used
  Linux user/mount/PID/network namespace tool. It requires a usable unprivileged
  user namespace and is therefore Linux-only; Swico uses it only when the
  readiness probe succeeds and then requires the hostile verification.
* [Anthropic sandbox-runtime](https://github.com/anthropics/sandbox-runtime)
  was considered, but its current project describes itself as a beta research
  preview, uses the same Seatbelt/bubblewrap primitives on macOS/Linux, and
  describes Windows as alpha with a one-time elevated setup. It does not give
  this package a verified normal-user Intel-mac and Windows boundary, so it is
  not bundled.
* [microsandbox](https://www.npmjs.com/package/microsandbox) was considered as
  a microVM option. Its published platform requirements do not cover the
  required macOS Intel target and introduce VM/runtime prerequisites, so it is
  not bundled as a transparent npm dependency.

Windows restricted tokens, Job Objects, AppContainer, and Windows Sandbox
remain candidates for a separately reviewed native adapter. No implementation
in this checkout has been proven to enforce both filesystem and network
isolation for a normal Windows x64 user, so Windows remains unavailable.

The native diagnostic is shipped in the CLI as
`swico sandbox diagnose --progressive --json`; it uses the same production
profile generator as agent execution, records each progressively constrained
profile, and exits nonzero unless native readiness is genuinely established.
The repository command `npm run sandbox:diagnose:macos` is only a thin wrapper
around that installed runtime implementation.

## Proof required before enabling an agent

`swico sandbox status` reports runtime detection and a diagnostic such as
`binary_missing`, `profile_rejected`, `sandbox_apply_denied`,
`ubuntu_apparmor_userns_restricted`, `linux_userns_restricted`, or
`namespace_unavailable`. It is not a security proof. On Linux it also reports
bounded values for `kernel.unprivileged_userns_clone`,
`user.max_user_namespaces`, and (when present)
`kernel.apparmor_restrict_unprivileged_userns`; these values explain a host
failure but never establish isolation by themselves.

`swico sandbox diagnose --progressive --json` reports `policy_denied_expected`
for an intentionally denied child under a deny-default control,
`host_sandbox_apply_denied` when the enclosing host refuses to apply a policy,
`sandbox_abort` for a child abort, and `runtime_permission_missing` when the
profile starts but lacks a required runtime grant. Only a complete hostile
probe run can establish native readiness.

`swico sandbox verify --json` executes real child processes under the adapter
and creates only disposable fake files and a local loopback test server. It
checks workspace read/write, outside-workspace access, a fake home secret,
secret environment stripping, network denial, child-process inheritance, and
symlink escape. A platform is verified only if every required allow/deny
expectation passes. The report records the runtime platform, architecture,
Node version, and timestamp but never stores secrets.

The dedicated Linux CI acceptance job is
`.github/workflows/agent-native-isolation.yml`; it prepares only its ephemeral GitHub host
by recording these settings and, when the host permits it, enabling
unprivileged user namespaces and clearing Ubuntu's user-namespace AppArmor
restriction for that disposable job. This is not a Swico runtime change and
is not a recommended user-machine workaround. A strict native job still fails
unless `verified=true` and every hostile probe ran. Linux operators must
configure host policy administratively and run the hostile probes on each
supported architecture. This workflow is intentionally separate from ordinary
CLI/package CI and npm artifact publication: a green public CLI release does
not establish local-agent native readiness. Windows and this development macOS
host currently fail closed.
