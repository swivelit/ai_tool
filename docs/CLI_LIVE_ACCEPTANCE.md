# Swico CLI live acceptance (historical RC8 operator record)

The RC8 acceptance below is historical evidence, not the current release
procedure. The current published package is
`@swiveltechnologies/swico@0.2.8`; use the exact canonical artifact and
revision from the current green release workflow for any new acceptance.

This checklist is for the exact canonical `@swiveltechnologies/swico` RC8
artifact and a dedicated allowlisted eligible paid account. It is not run by
CI or by ordinary release checks. Do not put access or refresh tokens in
command output, screenshots, issue comments, or logs.

Before starting, confirm `SWICO_CLI_ENABLED=true`, the existing nonempty tester
allowlist, `SWICO_CLI_AGENT_ENABLED=false`,
`SWICO_CLI_CLOUD_AGENT_ENABLED=false`, and `SWICO_CLI_MAX_AGENT_STEPS=8`. Do
not substitute Swico Free, a customer provider key, or a different account.

## Historical RC8 live result

The owner-confirmed RC8 acceptance passed once. The tested request was
`2773b5f9-bd75-4667-a26c-8a3b533bf2dc`; its usage charge was settled with one
matching `usage-debit:2773b5f9-bd75-4667-a26c-8a3b533bf2dc`. Safe billing
evidence recorded 16,823 micros debited, wallet `4,936,633` micros before and
`4,919,810` micros after, with reservation expansion/release reconciled and
final reserved balance zero. Browser-approved Lite login, API health,
same-account refresh, native macOS Keychain persistence, logout, and fresh
browser reauthorization also passed. No credential or token values are part of
this record. This is historical RC8 evidence; the stable metadata promotion
does not repeat a paid request automatically.

## Exact canonical artifact

Download artifact `swico-cli-0.2.0-rc.8-release-candidate` from CI run
`34911573230`. Use only
`swiveltechnologies-swico-0.2.0-rc.8.tgz` from that artifact. Do not rebuild a
local tarball for this acceptance. Verify SHA-256 before installing:

```sh
# macOS
shasum -a 256 swiveltechnologies-swico-0.2.0-rc.8.tgz

# Linux
sha256sum swiveltechnologies-swico-0.2.0-rc.8.tgz
```

```powershell
# Windows PowerShell
Get-FileHash .\swiveltechnologies-swico-0.2.0-rc.8.tgz -Algorithm SHA256
```

Expected SHA-256 is:

```text
8866e8eda089ad096f3c11203dbba77af722deb9a594ffd66cdb45a24ca083cb
```

Stop if the hash differs. Install into a disposable pilot prefix, preserving
the existing global installation:

```sh
mkdir -p "$HOME/.local/share/swico-rc8-live"
npm install --global \
  --prefix "$HOME/.local/share/swico-rc8-live" \
  ./swiveltechnologies-swico-0.2.0-rc.8.tgz
SWICO="$HOME/.local/share/swico-rc8-live/bin/swico"
"$SWICO" --version --json
```

Proceed only when the identity is exactly:

```text
package:  @swiveltechnologies/swico
version:  0.2.0-rc.8
revision: f029622c00ff903ccda9e3e95823abd58ee43411
dirty:    false
```

Record the absolute executable path. On Windows use the installed `swico.cmd`
in the equivalent prefix and verify the same JSON fields.

## Paid-account sequence

1. Run `$SWICO login --tier lite` (or a separately approved `standard` or
   `pro`) and complete fresh browser authorization. Then run `$SWICO whoami`.
   Record only the expected account identity and paid tier.
2. Run `$SWICO doctor`. Confirm API reachability and valid authorization. A
   sandbox-unavailable diagnostic is not a paid Chat failure.
3. Run `$SWICO usage --json`, then open `$SWICO` and run `/usage`. Record only
   safe wallet/estimate fields before the request. At the shell, use
   `$SWICO usage`; `/usage` is an in-application command.
4. Make one small deterministic paid Chat request. Do not request agent
   execution. Record the exit code and any safe request/session identifier.
5. Run `/usage` again and `$SWICO usage --json`. Reconcile the request ID,
   reservation, settlement, or request-audit record with the shared billing
   ledger where authorized. A wallet delta alone is not exactly-once proof.
6. Make a second small interaction in the same interactive process and confirm
   it completes without a new login or account/tier change.
7. Exercise the existing controlled 900-second access-token expiry path. After
   expiry, make an approved small request in the same process. Confirm refresh,
   account, tier, safe rotated-credential persistence, and no duplicate charge.
   Never record token values.
8. Close Swico and start a fresh process. Run `$SWICO whoami` to confirm the
   selected native credential store restores the account. If memory-only was
   explicitly selected, confirm that it does not persist instead.
9. In the website open **Settings → Data controls → Terminal sessions**. Match
   the full non-secret session ID plus device/last-seen information to this
   terminal; do not revoke by display name alone.
10. Select **Revoke**, confirm it, and verify the success notice and updated
    list while local credentials remain present.
11. With those retained local credentials, run `$SWICO whoami` and make one
    small Chat request. Both must be rejected by the server before provider or
    billing admission.
12. Run `$SWICO logout` and confirm only the local credential entry is deleted.
13. Reauthorize only through a fresh browser-approved paid-tier login. Confirm
    the revoked authorization was not reused.

Controlled, non-billable tests separately cover expired tokens, insufficient
budget, invalid output schemas, cancellation, duplicate requests, and
unsupported model/contract responses. A proposed spending cap is not a release
control unless the existing server enforces it.

## Evidence template

Record only safe values:

```text
date/time:
artifact SHA-256: 8866e8eda089ad096f3c11203dbba77af722deb9a594ffd66cdb45a24ca083cb
version: 0.2.0-rc.8
source revision: f029622c00ff903ccda9e3e95823abd58ee43411
platform/architecture:
Node version:
account identifier/email (owner-approved, optional):
tier:
terminal session ID:
request ID:
usage before/after:
correlated billing outcome:
same-process refresh:
native credential persistence:
website revocation:
post-revocation rejection:
final PASS/FAIL:
```

Never record access/refresh/Firebase tokens, Razorpay secrets, provider keys,
credential files, or environment dumps. Do not create database writes solely
to manufacture evidence, and do not run an automated paid loop.

Native local-agent smoke remains blocked until hostile sandbox verification and
the separate disposable coding workflow pass. A terminal release pass is not
sandbox proof.
