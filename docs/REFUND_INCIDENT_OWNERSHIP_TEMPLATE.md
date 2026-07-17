# Refund and financial-incident ownership template

Complete this in the private operations system. Do not commit personal phone numbers, customer data, credentials, provider payloads, or database URLs.

## Ownership

- Primary on-call role:
- Backup role:
- Incident commander role:
- Refund approval role:
- Ledger adjustment approval role:
- Customer communications role:
- Razorpay escalation owner:
- Render/database escalation owner:
- Private incident channel and paging destination:

## Severity and response

- High-severity triggers: negative wallet/reservation, invalid reservation invariant, captured-but-uncredited payment, duplicate financial reference, failed refund, stale reservation, payment/webhook mismatch, reconciliation finding.
- Acknowledge target:
- Checkout-disable authority:
- Customer update target:
- Evidence retention location/duration:

## Safe first response

1. Set `BILLING_CHECKOUT_ENABLED=false` and deploy if new-order risk exists; existing token credits remain usable.
2. Preserve logs and safe IDs. Never paste names, emails, content, signatures, payloads, keys, or URLs into shared channels.
3. Run the read-only audit and Razorpay reconciliation dry-run with `--fail-on-findings`.
4. Compare provider state, orders, wallet, and append-only ledger under dual review.
5. Use only idempotent service operations or approved compensating ledger entries; never rewrite/delete financial history.
6. Communicate gross payment/refund money and estimated token reversals without representing credited capacity as cash.
7. Record cause, scope, remediation, customer impact, approval, and follow-up tests.

## Closure evidence

- Incident timeline:
- Safe affected internal IDs/counts:
- Provider case reference:
- Refund decisions and approvals:
- Reconciliation/audit clean run:
- Sentry/Render notification evidence:
- Restore/rollback decision:
- Customer communication evidence:
- Preventive action owner and due date:
