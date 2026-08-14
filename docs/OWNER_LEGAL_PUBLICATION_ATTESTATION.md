# Swico Owner Legal Publication Attestation

Attestation reference: SWICO-OWNER-PUBLICATION-2026-07-18  
Attestation date: 2026-07-18  
Business: Swivel Technologies  
Product: Swico  
Approved for publication by: Authorised Partner, Swivel Technologies  
Legal-review status: Not reviewed or approved by legal counsel

This is a historical owner attestation for the policy content and package
description that existed on 2026-07-18. It is not approval of the revised
website billing, subscription, referral or token-presentation wording now
proposed in `web/src/content/legalContent.json`.

This attestation does not represent:

- approval by a lawyer or law firm;
- legal advice;
- certification of compliance with every applicable law;
- approval by Razorpay;
- permission to enable Razorpay Live Mode.

The owner confirms that, before public deployment:

- the stated legal business identity matches business records;
- the registered business address may lawfully be published;
- the published support, billing-support and privacy email addresses exist and
  are actively monitored;
- the listed support phone number is operational;
- the historical ₹10, ₹50, ₹100 and ₹500 package statement matched the product
  at the time of this record; it must not be reused for the current product;
- the 50/50 Token Credit allocation matches the backend configuration;
- refund and support commitments can be operationally fulfilled;
- named providers and data-processing statements reflect the deployed service;
- policy version 1.0 and effective date 2026-07-17 are intentionally adopted.

This record authorised publication of the exact policy content present in
`web/src/content/legalContent.json` at the time of this attestation. It did not
record a SHA-256 fingerprint. The current revised content requires a new
authorised owner or counsel approval record containing the exact canonical
legal-content SHA-256 before publication.

Approval workflow for the revised content:

1. Review the exact proposed pages in `web/src/content/legalContent.json`,
   including the current ₹15/₹299/custom PAYG wording and the separate Chat and
   Voice subscription/referral wording.
2. Run `python scripts/check-legal-publication.py` after inserting the real
   authorised approval metadata and the fingerprint calculated by the checker.
3. Record the same fingerprint in the signed/authorised approval evidence and
   in the publication metadata. A later material content change invalidates it.
4. Keep checkout, subscriptions and referrals disabled until the checker passes.

Future material policy changes require a new dated attestation and version.
