# Production capability baseline

## Accepted baseline

The production-capability gate reached its first fully green closeout at commit
`1c84dc7e8f87561998b028d041a0e8a1371c5bb3`:

- Overall score: **98.21**
- Question scenarios: **73 total; 70 passed; 0 failed; 3 skipped**
- Workflows: all passed or honestly skipped
- Chat debit: **0 micro-INR**
- Voice debit: **0 micro-INR**
- Cleanup: **complete**
- Deployment parity: **matched**

The retained evidence supplied for this repository closeout did not include the
safe summary's `scores_by_category` or `scores_by_tier` values. Those values must
be copied verbatim from the private run's redacted
`production-capability-summary.json`; they must not be reconstructed from the
overall score or raw answers. This repository record therefore leaves that
breakdown explicitly unasserted rather than publishing invented numbers.

### Skipped coverage at the accepted baseline

| Check | Recorded reason | Follow-up |
| --- | --- | --- |
| I01 | The deployed TTS route did not expose the required safe CI contract. | Keep skipped until the supported protocol can be exercised without a microphone. |
| I02 | The deployed Tamil TTS/STT route did not expose the required safe CI contract. | Same prerequisite as I01. |
| I03 | Secure realtime audio injection is unavailable in the current authenticated helper. | Never simulate a pass. |
| J-DISCONNECT-RECOVERY | Existing production helpers do not expose safe stream-disconnect injection. | Add coverage only through a product-supported failure mechanism. |
| J-BILLING-UI | The dedicated acceptance account is billing-exempt, so the real add-credit flow is unavailable. | Validate the real payment path manually. |
| J-FEEDBACK | The deployed capability/eligible-message precondition was unavailable for this run. | Keep the workflow honest until both are available. |
| K-OWNER-ISOLATION | A second acceptance credential pair was unavailable at this historical baseline. | The gate now requires the second account and fails rather than skips when it is absent. |

The scenario total counts I01-I03 as the three skipped question scenarios. The
J/K rows are workflow coverage and are not part of that 73-question count.

The real Razorpay payment path is **not covered** by this billing-exempt gate.
Each release still requires a separately authorized manual top-up test; the
capability workflow must never create a real payment order.

## Fixed-vocabulary validator inventory

This inventory is intentionally descriptive. It does not loosen any check. A
fixed-vocabulary check is appropriate for exact facts and protocol syntax, but
semantic checks remain vulnerable to reasonable synonyms, grammar, or negated
mentions unless explicitly noted.

### Backend answer validators

| Location | Fixed vocabulary or substring decision | Synonym/negation risk |
| --- | --- | --- |
| `web_ai/generation/task_requirements.py::_architecture_area_from_label` | Maps numbered headings to ten architecture areas with label regexes. | A semantically equivalent heading outside `database/schema`, `transaction boundary`, `state transition`, and the other listed labels is not recognized as a section. |
| `task_requirements.py::_architecture_mechanism` | Uses area-specific lists for database schema, transaction boundaries, state transitions, pseudocode, out-of-order handling, recovery, reconciliation, security, and test plans. | A correct mechanism expressed with a new synonym can fail; this was the source of multiple B03 false negatives. |
| `task_requirements.py::_duplicate_semantics` | Recognizes listed deduplication mechanisms and no-repeat outcomes. | An equivalent exactly-once mechanism can fail if neither its mechanism nor stable outcome uses the enumerated language. |
| `task_requirements.py::evaluate_idempotency_semantics` | Definition, retry example, and stable outcome each use fixed verb/noun families. | Correct examples using an unlisted retry construction or convergence phrase can fail. |
| `task_requirements.py::evaluate_authority_semantics` | Recognizes source-of-truth/system-of-record language and a bounded list of Redis/Valkey negations. | New non-authoritative phrasing can fail; affirmative-store mentions are clause-scoped and negation-aware, reducing but not eliminating mention risk. |
| `task_requirements.py::extract_task_requirements` | Detects definition/example/comparison/authority/transaction/pseudocode/context requirements from fixed instruction phrases. | A user can state the same requirement with an unlisted verb and receive no corresponding check. |
| `task_requirements.py::validate_task_requirements` definition/example/comparison checks | Requires listed definition, example, and comparison markers. | Correct prose without `means/is`, `for example/scenario`, or `whereas/versus/trade-off` can fail. |
| `task_requirements.py::validate_task_requirements` repository validation claim | Detects run/pass claims and non-execution disclaimers from fixed word lists. | A novel disclaimer may look like an execution claim; a bare mention is not by itself decisive, but nearby verbs drive the result. |
| `task_requirements.py::validate_task_requirements` repository stack check | Requires explicit rejection terms for forbidden frameworks and a named actual-stack term. | A correct answer that implies incompatibility without the listed rejection language can fail. |
| `task_requirements.py::validate_task_requirements` missing-path check | Uses fixed absence phrases and behavior verbs. | An honest refusal with a new inability phrase can fail, while a negated behavior verb can be mistaken for invention. **Mention-sensitive.** |
| `task_requirements.py::validate_task_requirements` transaction/pseudocode checks | Requires transaction/start/commit-or-rollback groups and fenced or statement-like pseudocode words. | Equivalent transaction notation or prose pseudocode can fail. |
| `task_requirements.py::validate_task_requirements` contextual grounding/re-ask/duplicate-fix checks | Matches captured stack terms plus fixed re-ask, failure-mode, uniqueness, and transaction words. | A polite re-ask synonym or a valid duplicate fix expressed differently can be missed. |
| `web_ai/generation/repository_grounding.py::cited_repository_paths` | Path regexes plus a fixed uncertainty list distinguish citations from echoed/refused paths. | A new uncertainty construction can turn a denial into a cited path. Prompt echoes are excluded, but ordinary mentions remain sensitive. **Mention-sensitive.** |
| `web_ai/generation/output_format.py::has_unfenced_code_like_content` | Detects selected code-leading tokens and indented punctuation shapes. | Code in an unlisted language can be missed; ordinary prose beginning with a listed token can be flagged. |
| `web_ai/generation/answer_guard.py::_task_completeness` | Treats TODO/TBD/omission phrases and selected trailing punctuation as incomplete. | A synonym for omitted work can pass; a legitimate answer ending with a colon or dash can fail. |
| `answer_guard.py::AnswerGuardContext.repository_validation_required` | Repository-change intent uses fixed change/repository terms. | A change request phrased without either list can skip repository validation. |
| `web_ai/generation/output_contract.py::extract_output_contract` | Extracts exact bullets, fences, JSON, sentences, Tamil, questions, word counts, phrases, final word, title, and intro prohibitions from fixed instruction grammar. | An equivalent constraint outside that grammar is not enforced. Validation is deterministic once extracted. |
| `output_contract.py::validate_output_contract` title heuristic | A short punctuation-free first line can be classified as a title. | A story's intentionally short opening line can be a false positive even without a title. |
| `web_ai/generation/claim_verifier.py` and `answer_guard.py` citation checks | Citation IDs, headings, and factual-section candidates are syntax/character-pattern based. | Nonstandard but valid citation syntax fails; unusual prose sections can be over- or under-classified. |

### Production-capability browser evaluator

| Location | Fixed vocabulary or substring decision | Synonym/negation risk |
| --- | --- | --- |
| `productionCapabilitySafety.ts::hasAffirmativeWaitAdvice` | Detects `wait for/until` and a fixed preceding-negation set. | A new negative construction can be mistaken for unsafe wait advice. **Mention-sensitive.** |
| `productionCapabilitySafety.ts::evaluateEditedBranchStack` | Requires Django/MySQL/Valkey and detects superseded-stack assertions with an advisory/negation list. | New advisory wording could still turn a cautionary mention into an assertion, though the earlier bare-substring bug is fixed. **Mention-sensitive.** |
| `productionCapabilitySafety.ts::evaluateRepositoryAbsenceAnswer` | Uses fixed inability, modal, hypothetical, negation, and affirmative-claim patterns. | New modal/refusal grammar can still look affirmative; mixed sentences are intentionally evaluated separately. **Mention-sensitive.** |
| `productionCapabilitySafety.ts::hasInsufficientEvidenceLanguage` | Reuses the repository uncertainty vocabulary. | A valid evidence disclaimer using an unlisted phrase can fail. |
| `productionCapabilitySafety.ts::evaluateIdempotencySemantics` | TypeScript twin of the backend definition/example/stable-outcome lists. | Same synonym risk as the Python validator; shared fixtures reduce implementation drift, not vocabulary incompleteness. |
| `productionCapabilitySafety.ts::evaluateWebhookArchitecture` | TypeScript twin of all ten architecture and authority vocabularies. | Same synonym/negation risk as Python; shared fixtures and disagreement checks detect drift. |
| `production-capability.spec.ts::providerIdentifierVisible` | Any listed provider/model token is a privacy failure. | This deliberately fails on a mere mention, including a benign one. **Mention-sensitive by policy.** |
| `production-capability.spec.ts` A03-A09 cases | Capability, refusal, live-data honesty, credential safety, and emergency guidance use fixed keyword groups. | Correct safety/help language using novel synonyms can fail; A05 intentionally treats provider mention as exposure. **Mention-sensitive for A05.** |
| `production-capability.spec.ts` C01-C09 cases | Exact facts are substrings; contradiction, Tamil, railway setting, dialogue, and title checks use fixed patterns. | Exact facts are stable; contradiction/setting/title synonyms and punctuation can false-negative or false-positive. |
| `production-capability.spec.ts` D02-D05 cases | Continuity, transaction, lock comparison, topic reset, and old-topic leakage use fixed terms. | Correct architecture synonyms can fail; D05 fails for merely mentioning an old topic even to disclaim it. **Mention-sensitive.** |
| `production-capability.spec.ts` E/F cases | Expected fixture facts and insufficient-evidence/conflict/stale-source terms are substring checks. | Exact fixture values are appropriate; F03 conflict synonyms can fail, and F04 fails any Coimbatore mention even when explicitly rejected. **Mention-sensitive for F04.** |
| `production-capability.spec.ts` G01/G03/G05 cases | Repository roots, validation claims, and non-React recognition use fixed file/function/framework phrases. | Equivalent explanations can fail; G03 can misread novel negation, and G05 requires an explicit listed React denial. |
| `production-capability.spec.ts` G04 case | Delegates to the clause-aware repository-absence evaluator. | Safer than a bare keyword list, but retains the modal/inability inventory risk above. |
| `production-capability.spec.ts` H02-H05 cases | Memory markers and Tamil script/sentence counts use literal markers and Unicode ranges. | H03/H04 fail any marker mention, including an explicit denial of recall. **Mention-sensitive.** |
| `production-capability.spec.ts` routing assertions | R01 checks fences and `available modes`; R02/R03 amounts/labels; R07 uses a Tanglish word list. | A correct Tanglish reply using different colloquial words can fail; R01's prohibited phrase is mention-sensitive. |
| `production-capability.spec.ts` severity/classification mapping | Reason-code substrings such as `secret`, `wrong`, `hallucinated`, and `validation_claim` set acceptance/severity. | A new reason code can receive the wrong classification until added; this operates on bounded reason codes, not answer text. |

When changing one of these checks, add shared positive, synonym, negation, and
mention-only fixtures where Python and TypeScript twins exist. Do not broaden a
production acceptance predicate solely to make one observed answer pass.
