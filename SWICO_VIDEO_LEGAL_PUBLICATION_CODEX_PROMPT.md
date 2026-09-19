# Codex task: Swico video legal publication + synthetic-media compliance hardening

You are working in the Swico repository root. Use high reasoning effort.

## Current baseline

Current production/application commit observed by the operator: `6f35de58` (`fix(video): harden rights onboarding and release gating`). CLI remains 0.2.9 unless the repository itself has advanced automatically; do not manually downgrade or bump it.

Production database head is already `20260918_website_video`. Do not edit, replace, downgrade, stamp or reset that migration. This task should not need a DB migration unless you discover a genuinely unavoidable schema requirement; if so, stop and explain before creating one.

The Intel Mac worker is already paired successfully with Render. `doctor --check-api` reports authenticated=true, schema_ready=true, control_initialized=true, runtime ready and tools ready. Both templates are already imported. Do not re-import or replace their masters.

Production video rollout must remain disabled during this task:

- `SWICO_VIDEO_ENABLED=false`
- `SWICO_VIDEO_PAID_CHECKOUT_ENABLED=false`

Do not change Render, deploy, push, enable checkout, rotate credentials, send customer emails, charge customers, publish templates or modify the production DB.

## Non-negotiable truthfulness boundary

Do NOT create, invent or imply any licence or permission from InsightFace, FaceFusion, movie studios, performers, music owners, record labels, publishers or any other third party.

Do NOT create a fake commercial permission letter, fake licence evidence, fake model-rights evidence, fake template-rights evidence, fake counsel approval, fake Grievance Officer identity, fake reviewer, fake signature or fake legal opinion.

Swivel Technologies may author its own user terms, privacy notice, consent/attestation text, synthetic-media disclosure policy, refund/delivery policy, grievance process and owner publication attestation. Those documents must clearly state that they do not create third-party rights.

Keep the existing restricted-model rights gates fail-closed. A Swico owner attestation must never satisfy a field that is meant to represent a third-party model licence/permission.

## Source legal pack

The operator has a drafting pack named `swico_video_legal_pack_2026-09-19.zip`. If it is present in the repo root or an adjacent operator-supplied path, inspect it. If it is not present, implement the requirements below from the existing repository content; do not block merely because the pack is absent.

Expected pack documents conceptually cover:

- template-video Terms addendum;
- template-video privacy notice;
- explicit adult/source-face consent and rights attestation;
- synthetic-media disclosure/provenance policy;
- acceptable-use/abuse policy;
- video refund/delivery/retention policy;
- grievance/impersonation/takedown procedure;
- internal template-rights attestation form that explicitly does not create rights;
- owner legal-publication attestation template;
- release legal checklist.

## Applicable product/legal design requirements

Inspect the current `web/src/content/legalContent.json`, `web/src/content/videoLegalDraft.json`, `backend/app/video/policy.py`, `scripts/check-legal-publication.py`, `scripts/video_legal_diff.py`, `docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md`, video routes/UI, and all relevant tests before editing.

The final 2026 amendments to India's IT Rules relating to synthetically generated information introduced due-diligence obligations for covered intermediaries. Design the product/policy conservatively around the following concepts without making a legal conclusion that Swico is or is not a particular regulated category:

- prohibit unlawful synthetic media, including child sexual exploitative/abuse material, non-consensual intimate imagery, false documents/electronic records, deceptive false portrayal/impersonation and other unlawful content;
- prominently label synthetic/AI-edited visual media in the delivered media itself;
- embed permanent metadata or another appropriate technical provenance mechanism to the extent technically feasible, with a non-sensitive unique identifier for the generating/modifying computer resource/service;
- do not expose a Swico feature whose purpose is to suppress/remove Swico's own label or provenance;
- provide a prominent grievance process;
- operationally support the current applicable grievance/takedown timelines rather than publishing the old 48-hour/30-day wording where it conflicts with current rules.

Also keep the DPDP/privacy approach conservative: clear purpose-specific notice, adults-only source submission, consent/authority attestation, bounded temporary media retention, no reusable face library, no source media in analytics/RAG/chat memory, and a functioning privacy/grievance contact.

## Required work

### 1. Finalize the canonical video legal text

Use the existing seven canonical legal pages. Do not add duplicate public policy routes unless technically necessary.

Update `web/src/content/videoLegalDraft.json` so its proposed `pages` accurately and consistently cover the video feature across:

- Terms;
- Privacy;
- Cancellation and Refunds;
- Contact / grievance;
- AI Use and Limitations;
- Digital Delivery;
- Pricing.

At minimum include:

- adults-only template video;
- explicit source-person consent/authority;
- source-photo rights attestation;
- synthetic/AI-edited nature of output;
- prohibited NCII, minors, deceptive impersonation, fraud, false records/evidence and unlawful uses;
- ₹25 standalone price and complimentary allowance behavior already implemented by the backend;
- queue/ETA as estimate, not guarantee;
- ten-minute ready-result availability;
- email link does not extend expiry;
- bounded source/scratch retention and truthful limitations of deletion/backups/SSD unlinking;
- no reusable face library / no chat memory/RAG/analytics use of face media;
- refund behavior for infrastructure failure;
- prominent AI-edited label in the delivered video;
- technical provenance/unique generation identifier to the extent technically feasible;
- user must not use Swico to remove/suppress the Swico disclosure for deceptive use;
- grievance/takedown process and current applicable response targets;
- public contact details without inventing a named officer.

Do not claim that Swico owns template/model/media rights merely because an operator uploads or attests to something.

### 2. Product-level consent UX

In the website `/videos` request flow, add explicit unchecked confirmations before admission/payment. Reuse existing design language and accessibility patterns.

Require affirmative confirmation of:

- user is 18+;
- every supplied source face is an adult;
- user is the depicted source person or has clear permission for this specific AI face-replacement request;
- user has the right to upload/use each source photo;
- output is synthetic/AI-edited and not authentic evidence;
- prohibited-use acknowledgement;
- temporary retention/expiry acknowledgement;
- disclosure/provenance acknowledgement.

The backend must receive/version the attestation. If the current DB already stores a suitable consent version/policy fingerprint field, use it. Do not add a migration unless necessary. If no durable field exists but the existing job metadata can safely store a bounded consent version, use that. Explain the choice.

Do not collect identity documents or signature images.

### 3. Synthetic-media label/provenance implementation

Inspect the existing worker render/output path.

Implement a production output step so every delivered generated video has a clearly noticeable visual disclosure such as `AI-EDITED / SYNTHETIC MEDIA — SWICO` and a non-sensitive technical provenance identifier.

Requirements:

- label must be in the delivered video frames, not only the web UI;
- use existing FFmpeg tooling; no new infrastructure;
- provenance metadata must not include email, Firebase UID, raw user ID, source-photo hash, worker token, payment ID or other secret/personal identifier;
- generate a bounded opaque generation/provenance ID derived from an internal job identity using a one-way/non-reversible scheme or random server/worker-safe identifier already available;
- embed metadata to the extent supported by MP4/FFmpeg;
- the output validation pipeline must verify that the disclosure/provenance step succeeded before READY;
- do not provide a Swico option that removes the disclosure/provenance;
- tests must verify presence without relying on OCR of arbitrary user content where a deterministic overlay/probe assertion is possible.

Preserve original template audio unless the existing feature intentionally changes it.

### 4. Grievance/takedown operations

The current proposed policies include older response targets and a note that the appointed Grievance Officer name should be inserted. Do not invent the officer's identity.

Change the public wording to:

- publish `privacy@swiveltechnologies.in`, support contact and business address;
- state that a named Grievance Officer will be displayed once formally appointed if required;
- use current legally conservative acknowledgement/resolution wording;
- specifically prioritize NCII, morphed/impersonation and urgent privacy/safety reports according to applicable statutory timelines.

Add or update an internal operational runbook with the concrete SLA timers. Do not promise an operational capability that the product cannot currently meet; if a required timer is unsupported, add a release blocker/check rather than silently publishing an impossible promise.

### 5. Owner-attested publication path

The repository already supports a truthful `owner_approved` path in `scripts/check-legal-publication.py`.

Implement a safe, explicit local publication helper such as:

`python scripts/publish-video-legal.py --owner-attestation --approver-role "..." --approval-date YYYY-MM-DD --confirm-authority --confirm-not-counsel-reviewed`

Exact naming may follow repository conventions.

The helper must:

- be local-only and require a clean/expected source state;
- compare current published pages with `videoLegalDraft.json`;
- display the old and proposed page fingerprints;
- require explicit confirmations;
- refuse blank/placeholder approver roles or invalid dates;
- compute the exact canonical fingerprint itself;
- make a timestamped local backup of `legalContent.json` and `docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md` before modifying;
- copy only the approved `pages` from the video draft into canonical `legalContent.json`;
- preserve the real business identity/support/billing/privacy contacts;
- set `publicationStatus=owner_approved`;
- set `approvalType=owner_attestation`;
- set a unique writtenAttestationReference for this publication event;
- set `approvedByNameOrRole` from the explicit operator argument;
- set `approvalDate` from the explicit operator argument;
- set `legalReviewStatus=not_reviewed_by_counsel`;
- set the exact `approvedLegalContentSha256`;
- replace/update `docs/OWNER_LEGAL_PUBLICATION_ATTESTATION.md` with a truthful owner attestation containing the exact reference/date/fingerprint and the exact sentence required by the existing checker: `Not reviewed or approved by legal counsel`;
- explicitly state that owner publication approval is NOT third-party model/template/music permission and NOT a legal opinion;
- run/require `scripts/check-legal-publication.py` against the candidate state before final atomic publication;
- never claim `approved_by_counsel` unless genuine counsel evidence already exists and the operator explicitly chooses the pre-existing counsel workflow;
- never silently reuse the old counsel fingerprint/reference;
- be atomic: on validation failure leave the canonical published files unchanged.

Add a dry-run mode that changes nothing and prints the candidate fingerprint/reference.

### 6. Release checker integration

Keep the new rollout-hardening behavior from `6f35de58`.

After owner publication succeeds, `current_legal_publication_approved` should become true only because:

- canonical pages exactly match the video draft pages; and
- `check-legal-publication.py` validates the exact new owner-attested fingerprint.

Do not make legal readiness depend on third-party model/template rights documents; those remain a separate worker/model/template acceptance track and must remain truthful.

Do not let enabling the flags bypass missing native calibration or templates.

### 7. Legal-document repository pack

Create a sanitized tracked directory such as `docs/legal/video/` containing the Swico-authored documents that are useful for audit/operations, for example:

- `FEATURE_TERMS_ADDENDUM.md`
- `PRIVACY_NOTICE.md`
- `FACE_SOURCE_CONSENT_ATTESTATION.md`
- `SYNTHETIC_MEDIA_DISCLOSURE_POLICY.md`
- `ACCEPTABLE_USE_AND_ABUSE.md`
- `DELIVERY_REFUND_RETENTION.md`
- `GRIEVANCE_TAKEDOWN_RUNBOOK.md`
- `TEMPLATE_RIGHTS_INTERNAL_ATTESTATION_TEMPLATE.md`
- `OWNER_PUBLICATION_ATTESTATION_GUIDE.md`
- `LEGAL_RELEASE_CHECKLIST.md`

Do not track private evidence, signatures, model-rights documents, template licences or personal data. Add README language saying internal forms do not create third-party rights.

### 8. Tests

Add thorough tests for:

- owner-publication helper dry-run has no mutations;
- invalid role/date/confirmation rejected;
- old counsel approval is not silently reused;
- candidate fingerprint equals canonical page fingerprint;
- attestation reference/date/fingerprint exactly match metadata;
- owner attestation says `Not reviewed or approved by legal counsel`;
- failed legal checker causes atomic rollback/no partial publication;
- successful candidate passes `check-legal-publication.py` in a disposable fixture;
- video_policy_ready becomes true only when published pages equal draft and exact publication approval passes;
- source-face attestation starts unchecked and is required before payment/admission;
- backend rejects missing/stale consent version;
- synthetic label/provenance step occurs before READY;
- final MP4 includes the expected disclosure/provenance marker using a synthetic local fixture;
- no provenance metadata contains user email/UID/token/payment IDs;
- no disclosure-removal product control exists;
- grievance public wording no longer advertises stale 48h/30-day targets where current rules require shorter handling;
- no private evidence file is tracked;
- existing pricing/retention/allowance/payment behavior remains unchanged.

Run all directly affected tests. Because backend and web are modified, run the full backend suite and full web unit/typecheck/lint/build if feasible. Run worker tests, compile checks, legal-publication checks, product-language checks, secret scans and `git diff --check`.

Do not claim a provider/payment/SMTP/native-face-inference pass unless it actually occurred.

### 9. Documentation and operator commands

Update:

- `docs/VIDEO_MAC_SETUP.md`
- `docs/VIDEO_ACCEPTANCE.md`
- `docs/VIDEO_RELEASE_CHECKLIST.md`
- `docs/VIDEO_IMPLEMENTATION_REPORT.md`

The novice flow after this change should be explicit:

1. keep both Render video flags false;
2. deploy reviewed code;
3. review `python scripts/video_legal_diff.py`;
4. run legal publication helper in `--dry-run` mode;
5. if the operator is genuinely authorized to approve publication, run the owner-attestation publication command with a real accountable role/date and confirmations;
6. run `python scripts/check-legal-publication.py`;
7. verify Render release checker shows only technical/template/provider blockers, not legal-publication blocker;
8. continue model/template technical acceptance without fabricating third-party rights;
9. prepare/review/benchmark/publish templates;
10. foreground worker and LaunchAgent acceptance;
11. complimentary production acceptance;
12. payment/SMTP/cache expiry acceptance;
13. only then enable `SWICO_VIDEO_ENABLED=true` with paid checkout still false;
14. only after paid acceptance set `SWICO_VIDEO_PAID_CHECKOUT_ENABLED=true`.

## Product behavior to preserve

- ₹25 = 2500 paise per paid generation.
- READY output availability = 600 seconds.
- configured unlimited account remains complimentary.
- eligible weekly development testers remain at five complimentary video attempts/day.
- video allowance remains separate from weekly Chat credits.
- Android unchanged.
- Windows Swico Free unchanged.
- no new infrastructure.

## Final response

Report:

1. changed paths;
2. exact legal/publication design;
3. exact synthetic-label/provenance implementation;
4. exact consent UX/backend record;
5. owner-attestation helper and rollback behavior;
6. tests run and actual results;
7. migration impact;
8. exact Render steps;
9. exact Mac commands;
10. remaining technical/provider/external-rights prerequisites, clearly separated;
11. suggested commit message.

Suggested commit message:

`feat(video): publish owner-attested policies and synthetic-media safeguards`
