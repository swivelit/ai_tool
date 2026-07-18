# Legal publication status

This is a sanitized repository publication record. It is not legal advice,
legal approval, or certification that the policies comply with every applicable
law.

## Current publication basis

The seven Swico policy bodies are published under a business-owner attestation:

- publication status: `owner_approved`;
- approval type: `owner_attestation`;
- attestation reference: `SWICO-OWNER-PUBLICATION-2026-07-18`;
- attestation date: `2026-07-18`;
- legal-review status: `not_reviewed_by_counsel`.

The tracked owner record is
`docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md`. It permits repository publication
of the exact policy text adopted by the authorised business representative. The
policies have not been reviewed or approved by legal counsel. Future
professional legal review remains recommended.

## Published policies and routes

| Public policy | Publication route |
| --- | --- |
| Terms and Conditions | `/legal/terms` |
| Privacy Policy | `/legal/privacy` |
| Cancellation and Refund Policy | `/legal/refunds` |
| Contact and Support | `/legal/contact` |
| AI Use and Limitations Policy | `/legal/ai` |
| Digital Service Delivery / Shipping Policy | `/legal/delivery` |
| Pricing and Token Credits | `/pricing` |

`/legal/pricing` remains a compatibility route for the same pricing policy.
Each policy is version 1.0 with an effective date of 2026-07-17.

## Repository safeguards

`python scripts/check-legal-publication.py` validates the business identity;
support, billing-support and privacy email addresses; all seven policy bodies;
effective dates and published versions; empty sections; placeholders and
drafting markers; the canonical `/pricing` route; explicit publication status;
and the matching owner-attestation reference and date.

The checker also retains a separate `approved_by_counsel` path for a future
genuine professional review. That path cannot pass without explicit counsel
approval metadata. Plain `approved`, status/type mismatches, and incomplete or
mismatched owner attestations are rejected.

Passing repository checks means only that the content and accountable
publication record are structurally complete. It does not constitute legal
advice or legal-compliance certification.

## Payment release remains separate

Owner attestation permits repository publication; it does not approve Razorpay
Live Mode. Test and Live credentials, environment validation, webhook setup,
financial reconciliation, operational review and the two-phase checkout
cutover remain separate release decisions. The repository defaults remain
`RAZORPAY_MODE=test`, `BILLING_CHECKOUT_ENABLED=false`, and
`BILLING_CREDIT_PERCENT=50`.
