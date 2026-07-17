# Legal publication review intake

This is an intake checklist, not legal advice and not a representation that review is complete. Counsel or an authorized business owner must provide the approved text and publication metadata.

## Publication metadata

- Legal business identity:
- Registered/business address where required:
- Jurisdiction and governing-law decision:
- Public support contact:
- Privacy contact:
- Billing/refund contact:
- Effective date for each policy:
- Version for each policy:
- Approver, approval date, and evidence location:

## Required public structures

- Terms and Conditions
- Privacy Policy
- Cancellation and Refund Policy
- Contact and Support
- AI Limitations
- Digital Service Delivery / Shipping Policy
- Pricing/top-up disclosure

For every section, counsel should supply final body text, required statutory disclosures, audience/age restrictions, dispute language, retention/deletion rules, subprocessors, delivery timing, refund eligibility/timing, and support/escalation details appropriate to the operating jurisdictions.

## Product facts for review

- Customers pay a gross rupee amount through Razorpay.
- Exactly 50% is converted internally to prepaid AI usage capacity; exactly 50% is service/platform allocation. Odd fractional user paise are floored to the platform.
- Customer-facing Token credits are model-dependent estimates, not cash, withdrawable value, or a fixed provider-token quota.
- Actual use varies by provider/model, cached input, and input/output mix.
- Gross payments/refunds can be shown in rupees; balances, grants, reversals, use, and limits are not presented as money.
- Checkout can be disabled while existing token credits remain usable.

## Publication handoff

1. Replace metadata and section bodies in `web/src/content/legalContent.json` without changing page/component structure.
2. Set a non-draft version and ISO effective date for each page.
3. Set `publicationStatus` to `approved` only with retained approval evidence.
4. Run `python scripts/check-legal-publication.py`.
5. Review every route on desktop/mobile and confirm footer/Settings links.
6. Record the deployed commit and screenshots in the private release evidence.

Razorpay Live Mode and checkout must remain disabled while this checker reports blockers.
