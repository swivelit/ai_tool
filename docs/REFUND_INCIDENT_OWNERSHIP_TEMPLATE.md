# Refund and financial-incident ownership template

Complete ownership in the private operations system and mirror the required
role identifiers in `private/ops-ownership.json`. The `private/` directory is
Git-ignored. Never commit names, phone numbers, private channels, customer data,
credentials, provider payloads, database URLs, or the completed private file.

Financial response uses a minimum two-person control: the person proposing a
refund or compensating ledger adjustment must not be its sole approver. At least
two distinct people must be able to review ledger adjustments. Direct database
financial edits are forbidden; use only idempotent service operations or
approved, append-only compensating ledger entries.

## Private readiness record

Create `private/ops-ownership.json` locally with this shape, replacing every
example with private role/contact references. Timestamps must be ISO-8601 with
a timezone.

```json
{
  "primary_on_call": "private role or roster reference",
  "backup_on_call": "different private role or roster reference",
  "incident_commander": "private role reference",
  "checkout_disable_owner": "private role reference",
  "refund_owner": "private role reference",
  "ledger_adjustment_approvers": ["first private approver", "second private approver"],
  "customer_communications_owner": "private role reference",
  "razorpay_owner": "private role reference",
  "render_database_owner": "private role reference",
  "incident_channel": "private channel reference",
  "backup_contact_method": "private fallback contact reference",
  "acknowledgement_target_minutes": 10,
  "customer_update_target_minutes": 30,
  "evidence_location": "private access-controlled evidence location",
  "last_access_tested_at": "2026-07-01T10:00:00+05:30",
  "last_drill_completed_at": "2026-07-02T10:00:00+05:30"
}
```

Validate it locally; the checker prints field names only and never uploads or
sends the file. Do not add this command to normal CI because CI does not hold
the private operational record.

```bash
python scripts/check-ops-readiness.py --file private/ops-ownership.json
```

## Access-verification checklist

- [ ] Primary and backup are distinct and can acknowledge through the primary and backup contact paths.
- [ ] Incident commander and checkout-disable owner can reach Render and identify the correct API service without exposing configuration values.
- [ ] Refund and Razorpay owners can inspect Test Mode payments, refunds, and webhook delivery.
- [ ] Render/database owner can run the documented read-only audit and reconciliation dry-run.
- [ ] Two distinct ledger-adjustment approvers can access the approval record and append-only service workflow.
- [ ] Customer communications owner can use the private approved support channel.
- [ ] Evidence location is access-controlled, retention is defined, and a second operator can retrieve a synthetic drill record.
- [ ] `last_access_tested_at` is updated only after every access check succeeds.

## Refund escalation checklist

1. Record safe internal identifiers, impact, capture state, ledger state, and timestamps without copying customer PII or provider secrets.
2. Page the primary and backup; assign an incident commander and refund owner.
3. Disable checkout if new-order risk exists, preserving existing token-credit use.
4. Run the read-only financial audit and Razorpay reconciliation dry-run with `--fail-on-findings`.
5. Compare provider payment/refund state, internal order state, wallet, and append-only ledger under two-person review.
6. Approve an idempotent refund or compensating ledger operation through the supported service path. Never edit financial database rows directly.
7. Verify webhook replay/idempotency, resulting wallet state, ledger balance, and customer-visible status.
8. Send approved customer updates on the configured target and retain safe evidence.

## Required drills

Use synthetic staging records and Razorpay Test Mode only. Never run these
drills against production data.

### Captured-but-uncredited drill

- Detect the synthetic captured payment through the audit/reconciliation dry-run.
- Disable checkout, correlate safe provider/internal IDs, and prove two-person escalation.
- Apply only the documented idempotent recovery in staging; verify one credit and no duplicate on replay.

### Negative-wallet drill

- Detect the synthetic negative balance/reservation invariant and stop new risky operations.
- Prove the owner can distinguish usage settlement from a payment/refund issue.
- Review and approve an append-only compensating action; never overwrite wallet or ledger rows.

### Failed-refund drill

- Detect `refund.failed`, preserve the provider case reference, and notify the incident commander.
- Verify no premature token reversal is represented as final.
- Exercise the documented retry/escalation decision and customer-update clock under dual control.

### Checkout-disable drill

- Have the authorized owner set `BILLING_CHECKOUT_ENABLED=false` on the intended service and deploy.
- Verify order creation is unavailable while existing token credits and read-only billing history still work.
- Restore checkout only in isolated staging after Test Mode configuration and approval are reverified. Production remains disabled.

## Completion evidence

- [ ] Incident/drill timeline, commit, staging deployment, and safe internal test IDs.
- [ ] Primary/backup acknowledgements and two-person approval record.
- [ ] Checkout-disable and restore evidence.
- [ ] Read-only audit/reconciliation commands, exit status, and redacted output location.
- [ ] Provider Test Mode case/refund evidence and webhook replay result.
- [ ] Wallet/ledger invariant verification without direct database edits.
- [ ] Customer communication decision and timestamps.
- [ ] Follow-up owner, due date, and access/drill timestamps updated in the private record.
