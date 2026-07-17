# Legal publication status

This is a sanitized repository status record, not legal advice, legal approval,
or a copy of private counsel material.

## Source-material status

- A legal-copy handoff has been received.
- A business-information and counsel workbook has been received.
- Raw source files are stored only under the ignored
  `private/legal-source/` directory and are not tracked by Git.
- These files are the complete current handoff, but they do not contain the full
  exact publication text for all required policies.
- Route headings, placeholders, partial business information, and unresolved
  workbook answers do not constitute approved policy bodies.

## Required public policies and routes

| Public policy | Publication route |
| --- | --- |
| Terms and Conditions | `/legal/terms` |
| Privacy Policy | `/legal/privacy` |
| Cancellation and Refund Policy | `/legal/refunds` |
| Contact and Support | `/legal/contact` |
| AI Use and Limitations Policy | `/legal/ai` |
| Digital Service Delivery / Shipping Policy | `/legal/delivery` |
| Pricing and Token Credits | `/pricing` |

`/legal/pricing` remains the compatibility route for the same unpublished
pricing framework. Both pricing routes must retain the unpublished warning
until final publication is authorized.

## Publication blockers

### Approval

- Complete exact policy bodies are missing.
- Approval status is not complete.
- Counsel name or firm is missing.
- Written approval reference is missing.
- Approval date is missing.

### Business and contact

- The support email is not a valid email address.
- The billing-support email is missing.
- The privacy email is not a valid email address.
- Support hours are unresolved.
- The grievance contact and grievance decision are unresolved.

### Terms

- Applicable law and court jurisdiction are not specific.
- Liability and warranty terms have not been supplied.
- Generated-output rights terms have not been supplied.

### Privacy

- Retention periods are unresolved.
- The deletion process is unresolved.
- The email provider is unresolved.
- Provider-side retention and training details are unresolved.
- The privacy response period is unresolved.

### Refunds

- The refund window is unresolved.
- Refund eligibility and exclusions are unresolved.
- Consumed-credit treatment is unresolved.
- Refund treatment for the 50% allocation is unresolved.
- Tax and payment-fee treatment is unresolved.
- The bank posting timeline is unresolved.

### Delivery

- The normal delivery timeframe is unresolved.
- Escalation and resolution times are unresolved.

### Pricing

- Package confirmation is incomplete.
- Tax-inclusive or tax-exclusive treatment is unresolved.
- Invoice treatment is unresolved.

## Required safe state

The repository must not set `publicationStatus=approved` or enable Razorpay
Live checkout until all blockers are resolved and exact policy bodies are
received. `publicationStatus` therefore remains `unreviewed`, the public pages
remain visibly unpublished, Razorpay remains in Test Mode, and checkout remains
disabled. No claim of legal approval is being made.
