# Swico CLI live acceptance (operator opt-in)

This checklist is for the already-installed `@swiveltechnologies/swico` artifact
and a dedicated allowlisted eligible paid account. It is not run by CI or by
ordinary release checks. Do not put access or refresh tokens in command output,
screenshots, issue comments, or logs.

Before starting, confirm the backend has `SWICO_CLI_ENABLED=true`, the existing
nonempty tester allowlist, `SWICO_CLI_AGENT_ENABLED=false`,
`SWICO_CLI_CLOUD_AGENT_ENABLED=false`, and `SWICO_CLI_MAX_AGENT_STEPS=8`.

1. In a clean disposable desktop shell, confirm `swico --version`, `swico
   whoami`, `swico usage --json`, and `swico doctor`; record only account identity, tier, API status,
   and auth-valid status.
2. Record the website Chat usage/wallet value without exposing credentials.
3. In the installed CLI interactive session, run `/usage` and record the
   request/session-safe usage values before the request. Run one small paid
   Chat request, record its exit code, then run `/usage` again. Reconcile the
   before/after result with the applicable subscription allowance or PAYG
   ledger/request audit; a wallet difference without request correlation is
   not proof of exactly-once charging.
   `/usage` belongs inside Swico. At the macOS shell, use `swico usage` or
   `swico usage --json`; a shell command beginning with `/` is a zsh path, not
   a Swico command.
4. Wait for or simulate the controlled 900-second access-token expiry in the
   approved test harness. Make a request in the same interactive process and
   confirm refresh succeeds, the account/tier is unchanged, and the rotated
   credentials remain in the selected native store (or remain memory-only when
   that was explicitly selected).
5. In the website, open Settings → Data controls → Terminal sessions. Match
   the full non-secret session ID and device/last-seen information to the
   terminal from step 1; do not revoke an older session by display name alone.
   Select Revoke and Confirm revoke. Verify the success message and updated
   list while the local credential record is still present. Call `swico whoami`
   and one paid Chat request; both must be rejected by the server. Confirm the
   retained local record was not treated as authorization.
6. Restore only through a fresh browser-approved login with an explicit paid
   tier. Do not substitute Swico Free or a customer provider key.

Controlled, non-billable tests must separately cover expired tokens,
insufficient budget, invalid output schemas, cancellation, duplicate requests,
and unsupported model/contract responses. A proposed spending cap is not a
release control unless the existing server actually enforces it.

Native local-agent smoke remains blocked until hostile sandbox verification and
the PostgreSQL lifecycle job pass. If those gates pass, use a disposable
workspace and an isolated staging backend or an explicitly approved
tester-only pilot; do not change production flags during acceptance.
