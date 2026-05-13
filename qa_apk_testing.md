# QA APK Testing — Sprint Implementation Documentation

> [!IMPORTANT]
> This document tracks all QA automation sprint work.
>
> Every task must include:
>
> * Previous behavior/state
> * Previous implementation/code
> * Problems in old implementation
> * Updated implementation/code
> * Why the update was required
> * Why the new approach was selected
> * Post-update behavior
> * Verification results

---

# Phase 1 — Audit & Discovery

## Objective

Before implementing automation changes, the existing APK QA/testing architecture was audited to understand:

* current automation capabilities
* testing stack
* existing coverage
* missing regression flows
* safest implementation strategy

---

# Existing Testing Architecture

| Layer           | Framework                       | Purpose                               |
| --------------- | ------------------------------- | ------------------------------------- |
| Mobile Testing  | Vitest                          | React Native unit/integration testing |
| Backend Testing | Pytest                          | API and backend flow testing          |
| APK Automation  | Custom Bash + adb + XML parsing | UI automation on Android APK          |

---

# Existing APK Automation Design

The project already contained:

* `adb shell input tap`
* `adb shell input swipe`
* `uiautomator dump`
* Python XML coordinate parsing

instead of:

* Detox
* Maestro
* Appium

---

# Why Existing Architecture Was Retained

## Old Approach

Custom bash automation already existed.

## Alternative Considered

Possible migration to:

* Detox
* Maestro
* Appium

## Why New Frameworks Were NOT Used

Migrating would require:

* rewriting automation infrastructure
* changing existing validation flows
* rebuilding CI compatibility
* additional setup complexity

The existing harness already supported:

* APK launch
* UI parsing
* automation tapping
* screenshot capture
* adb interaction

Therefore:

> extending the current harness was safer, faster, and lower risk.

---

# Task 2 — APK Chat Automation Improvements

## Objective

Improve reliability of APK chat automation and strengthen regression validation.

---

# BEFORE UPDATE

## Previous Behavior

Before improvement:

* APK launch automation existed.
* Setup bypass existed.
* Basic message sending existed.
* Minimal validation existed.

### Existing Flow

```text
Launch APK
→ Skip setup
→ Send message
→ Wait for response
```

---

# Problems In Previous Implementation

| Problem                     | Impact                             |
| --------------------------- | ---------------------------------- |
| Weak response verification  | False positives possible           |
| No persistence validation   | Messages could disappear unnoticed |
| Limited logging             | Debugging failures difficult       |
| Limited artifact collection | Harder QA investigation            |

---

# Previous Code

```bash
tap_text "hello"
wait_for_text "hello"
```

---

# AFTER UPDATE

## Updated Behavior

The APK automation now:

1. launches app
2. bypasses onboarding
3. sends multiple chats
4. verifies both chats remain visible
5. captures screenshots
6. captures XML dumps
7. stores artifacts for debugging

---

# Updated Flow

```text
Launch APK
→ Mock authentication
→ Skip onboarding
→ Send first message
→ Verify first message
→ Send second message
→ Verify second message
→ Validate persistence
→ Capture artifacts
```

---

# Updated Code

```bash
capture_step "chat-first-message"
capture_step "chat-second-message"
capture_step "chat-persistence-verified"
```

---

# Why The Update Was Required

The original implementation validated only:

* basic interaction

The updated implementation validates:

* UI persistence
* multi-message reliability
* regression safety
* APK stability

---

# Why New Implementation Was Chosen

The updated automation:

* reuses existing harness
* avoids framework migration
* improves debugging
* improves CI reliability
* reduces flaky test behavior

---

# Post-Update Behavior

| Feature                  | Before     | After      |
| ------------------------ | ---------- | ---------- |
| Multi-chat validation    | ❌ No       | ✅ Yes      |
| Persistence verification | ❌ Weak     | ✅ Strong   |
| Artifact collection      | ⚠️ Limited | ✅ Improved |
| Regression reliability   | ⚠️ Medium  | ✅ High     |

---

# Verification Results

| Verification           | Result   |
| ---------------------- | -------- |
| APK launch             | ✅ PASSED |
| Setup bypass           | ✅ PASSED |
| Chat send flow         | ✅ PASSED |
| Persistence validation | ✅ PASSED |
| Artifact capture       | ✅ PASSED |

---

# Task 3 — Chat Deletion UI Automation

## Objective

Add automated APK regression testing for deleting chats from drawer history.

---

# BEFORE UPDATE

## Previous Behavior

Before implementation:

* chat deletion existed manually
* no automation coverage existed
* no delete selector existed

### Existing User Flow

```text
Open drawer
→ Long press chat
→ Tap delete
→ Confirm delete
```

---

# Problems In Previous Implementation

| Problem                  | Impact                                 |
| ------------------------ | -------------------------------------- |
| No automation selector   | adb could not reliably target elements |
| Manual-only testing      | regressions could go unnoticed         |
| No deletion verification | failures difficult to detect           |

---

# Previous Code

```tsx
<Pressable
  onLongPress={() => openHistoryItemActions(item)}
  delayLongPress={220}
>
```

---

# AFTER UPDATE

## Updated Behavior

The APK automation now:

1. opens drawer
2. long-presses chat item
3. opens delete action sheet
4. confirms native Android alert
5. verifies removal from XML dump

---

# Updated Code

```tsx
<Pressable
  onLongPress={() => openHistoryItemActions(item)}
  delayLongPress={220}
  testID="chat-history-item"
  accessibilityLabel="chat-history-item"
>
```

---

# Additional Updated Code

```tsx
<Pressable
  onPress={deleteSelectedHistoryItem}
  style={styles.actionSheetRow}
  testID="chat-delete-button"
  accessibilityLabel="chat-delete-button"
>
```

---

# Why The Update Was Required

The old implementation lacked:

* stable automation selectors
* reliable UI targeting
* deletion verification

The new implementation enables:

* stable adb selection
* reliable automation
* deletion regression testing

---

# Why The New Implementation Was Chosen

`testID` + `accessibilityLabel`:

* works reliably with uiautomator XML
* avoids fragile text matching
* improves automation stability

---

# Post-Update Behavior

| Feature                  | Before | After |
| ------------------------ | ------ | ----- |
| Chat deletion automation | ❌ No   | ✅ Yes |
| Stable selectors         | ❌ No   | ✅ Yes |
| Deletion verification    | ❌ No   | ✅ Yes |

---

# Verification Results

| Verification              | Result   |
| ------------------------- | -------- |
| Drawer open               | ✅ PASSED |
| Long press detection      | ✅ PASSED |
| Delete modal detection    | ✅ PASSED |
| Native alert confirmation | ✅ PASSED |
| Chat removal verification | ✅ PASSED |

---

# Task 4 — Voice Button Automation

## Objective

Add regression automation coverage for voice interaction flows.

---

# BEFORE UPDATE

## Previous Behavior

Voice interaction existed manually through:

* inline mic
* live Orb modal

However:

* no voice automation existed
* no stable Orb selector existed
* no modal close selector existed

---

# Existing Voice Flow

## Quick Mic Flow

```text
Tap mic
→ Start recording
→ Tap stop
→ Wait for response
```

## Live Orb Flow

```text
Open voice modal
→ Press and hold Orb
→ Speak
→ Release Orb
→ Wait for response
```

---

# Problems In Previous Implementation

| Problem                         | Impact                     |
| ------------------------------- | -------------------------- |
| Dynamic Orb accessibility label | unstable automation        |
| No voice modal selector         | unreliable modal dismissal |
| No voice regression coverage    | voice failures unnoticed   |

---

# Previous Code

```tsx
accessibilityLabel={
  listening ? "Recording, release to stop" : "Hold the orb to record"
}
```

---

# AFTER UPDATE

## Updated Behavior

The APK automation now:

1. opens voice modal
2. handles Android microphone permission dialog
3. finds Orb selector
4. simulates hold gesture
5. waits for assistant response
6. closes modal automatically

---

# Updated Code

```tsx
<Pressable
  accessible
  testID="voice-orb"
  accessibilityLabel="voice-orb"
  accessibilityRole="button"
  accessibilityHint={
    listening
      ? "Recording, release to stop"
      : "Press and hold the orb to record. Release to stop and send."
  }
>
```

---

# Additional Updated Code

```tsx
<Pressable
  onPress={() => setVoiceSheetOpen(false)}
  style={styles.voiceCloseButton}
  testID="voice-modal-close-button"
  accessibilityLabel="voice-modal-close-button"
>
```

---

# Why The Update Was Required

The old implementation used:

* dynamic labels

Dynamic labels create:

* flaky adb selection
* unstable automation
* inconsistent XML parsing

The new implementation provides:

* stable selectors
* reliable automation
* better regression coverage

---

# Why The New Implementation Was Chosen

Using:

* `testID`
* `accessibilityLabel`

is compatible with:

* adb
* uiautomator dump
* Android XML parsing

without modifying:

* voice logic
* animations
* state management

---

# Post-Update Behavior

| Feature                   | Before | After |
| ------------------------- | ------ | ----- |
| Voice automation          | ❌ No   | ✅ Yes |
| Stable Orb selector       | ❌ No   | ✅ Yes |
| Modal close automation    | ❌ No   | ✅ Yes |
| Voice regression coverage | ❌ No   | ✅ Yes |

---

# Verification Targets

* `voice-modal-opened`
* `voice-orb-found`
* `voice-recording-finished`
* `voice-response-success`
* `voice-modal-closed`

---

# Tasks 5 & 6 — Crash Scanner & Artifact Collection Improvements

## Objective

Improve APK regression diagnostics, crash visibility, and artifact collection reliability.

---

# BEFORE UPDATE

## Previous Behavior

Before improvement:

* crash scanning only detected basic Android fatal crashes
* React Native RedBox failures were often missed
* backend/API failures lacked dedicated markers
* screenshots were mostly captured only at the end
* failure context logs were not automatically extracted

### Existing Crash Scanner Flow

```text
Run APK automation
→ Collect logcat
→ Scan generic markers
→ Report FAIL/PASS
```

---

# Problems In Previous Implementation

| Problem                         | Impact                                     |
| ------------------------------- | ------------------------------------------ |
| Silent JS failures              | RedBox errors went unnoticed in automation |
| No failure-specific artifacts   | Debugging mid-test failures was difficult  |
| Generic crash markers           | Native llama or API errors were ignored    |
| Log fatigue                     | Analyzing full 10k line logs was slow      |

---

# Previous Code

```bash
CRASH_MARKERS=(
  "AndroidRuntime:FATAL EXCEPTION"
  "System.err"
  "signal 11 (SIGSEGV)"
)
```

---

# AFTER UPDATE

## Updated Behavior

The APK automation now:

1. scans for expanded markers (RN, Llama, Native, HTTP 500s)
2. automatically triggers "Failure Snapshots" on any failed step
3. extracts 120-line "Log Slices" specifically around the failure moment
4. generates a high-level `failure-summary.log` for non-technical triage

---

# Updated Flow

```text
Run APK automation
→ Step failure detected
→ TRIGGER: capture_step (with log slice flag)
→ SAVE: Screenshot + UI XML + 120 lines of logcat
→ LOG: failure-summary.log
→ Final post-mortem scan
```

---

# Updated Code (test_apk.sh)

```bash
# New failure handler
mark_failed() {
  RESULT=1
  FAILED_STEPS+=("$1")
  capture_step "failure-${safe_label}" 1 # Capture snapshot + log slice
}

# New scanner markers
CRASH_MARKERS=(
  "Unhandled promise rejection"
  "Invariant Violation"
  "JNI DETECTED ERROR"
  "llama.*error"
  "HTTP 500"
)
```

---

# Why The Update Was Required

The original implementation provided:

* no visual proof of mid-test failures

The updated implementation provides:

* immediate, localized diagnostics
* coverage for "silent" React Native crashes
* precise log context for backend/native failures

---

# Why The New Implementation Was Chosen

Automated "Log Slicing":

* reduces developer investigation time
* avoids manual log parsing
* differentiates between "Log Noise" and "Real Crashes"
* provides a clear audit trail for every failure

---

# Post-Update Behavior

| Feature                        | Before | After |
| ------------------------------ | ------ | ----- |
| React Native Error Detection   | ⚠️ Weak | ✅ High |
| Native/Llama Failure Detection | ❌ No   | ✅ Yes |
| Automatic Failure Snapshots    | ❌ No   | ✅ Yes |
| Failure Summary Logs           | ❌ No   | ✅ Yes |

---

# Verification Results

| Verification                          | Result   |
| ------------------------------------- | -------- |
| JS Exception Detection                | ✅ PASSED |
| Native JNI/Llama Detection            | ✅ PASSED |
| Auto-snapshot on failure              | ✅ PASSED |
| Failure-context log extraction (tail) | ✅ PASSED |
| Diagnostic integrity (Vitest)         | ✅ PASSED |

---

# Task 7 — Golden Assistant Evals

## Objective

Expand the regression coverage for multi-lingual routing and local/fallback behavior.

*(pending)*

---

# Final Sprint Impact

## Before Sprint

* partial APK automation
* weak regression validation
* limited selectors
* manual voice testing
* manual deletion testing
* generic crash scanning

---

# After Sprint

* stronger APK automation
* stable regression selectors
* automated deletion testing
* automated voice testing
* contextual diagnostic artifacts
* multi-layered crash scanning
* improved QA confidence

---

````md
# Task 7 — Golden Assistant Evals

## Objective

Expand the Golden Assistant regression evaluation system to provide stronger deterministic validation for:

* Tamil language assistant responses
* Tanglish (Tamil written using English alphabets) prompts
* local-first routing behavior
* memory/profile recall
* clarification handling for vague prompts
* backend/cloud fallback safety
* multilingual orchestration stability
* offline-safe assistant behavior

This task improves the QA infrastructure by ensuring that multilingual assistant flows, memory retrieval, clarification routing, and cloud failure handling are continuously verified through automated regression tests.

The goal was to strengthen confidence in the assistant’s orchestration layer without modifying production business logic or redesigning the assistant runtime.

---

# Before Update

## Existing Problems

Before the update, the Golden Assistant evaluation system had several important coverage gaps.

### Limited Language Coverage

The eval dataset was primarily English-focused.

Problems:
* no native Tamil regression tests
* no Tanglish regression tests
* no multilingual routing validation
* no Tamil output verification

This meant multilingual regressions could silently break without being detected during QA validation.

---

## No Tanglish Validation

The assistant supports users who type Tamil conversational phrases using English alphabets, for example:

```text
enna panra
saptiya
work tasks pathi sollu
````

However, no regression tests existed for:

* transliterated Tamil prompts
* mixed-language routing
* Tanglish tool selection
* Tanglish reminder queries

This created risk in:

* local routing logic
* intent recognition
* reminder/task retrieval

---

## No Memory Recall Verification

The previous eval runner only tested mostly single-turn assistant responses.

There was no automated validation for:

* stored profile recall
* user memory retrieval
* assistant fact lookup
* profile-answer injection

As a result:

* memory regressions could go undetected
* profile retrieval logic was not continuously validated

---

## No Clarification Safety Validation

Before the update:

* vague prompts were not tested
* destructive ambiguity handling was not verified
* clarification routing was not protected by regression tests

Example unsafe prompt:

```text
Delete it
```

There was no deterministic verification ensuring the assistant safely asks:

* “Which item?”
  instead of incorrectly guessing a destructive action.

---

## No Backend Failure / Fallback Testing

The mock API infrastructure always returned success:

```ts
return { ok: true };
```

Because of this:

* cloud failure behavior was never tested
* local fallback responses were unverified
* offline-safe orchestration had no regression coverage
* backend 500-error handling was not validated

This was one of the largest QA gaps in the eval system.

---

## Fragile Matcher Logic

The eval runner used strict case-sensitive matching:

```ts
text.includes(needle)
```

Problems:

* false negatives from capitalization changes
* unstable LLM response matching
* Tanglish matching inconsistencies
* unnecessary regression failures

Example:

* `"Review PR"` could fail against `"review pr"`

even though the meaning was correct.

---

## Existing Eval Runner Behavior

The original eval system mainly verified:

* basic route matching
* simple tool assertions
* direct substring checks
* English-focused responses

The system lacked:

* multilingual awareness
* fallback simulation
* clarification verification
* memory injection
* offline-safe orchestration testing

---

# After Update

## Overview

The Golden Assistant regression framework was expanded to support deterministic multilingual and orchestration validation while preserving backward compatibility with the existing eval infrastructure.

The implementation remained:

* lightweight
* deterministic
* QA-focused
* regression-safe
* orchestration-compatible

No production assistant logic was modified.

---

# New Regression Eval Cases Added

Five new high-value regression scenarios were added.

---

## 1. Tanglish Routing Validation

### Eval ID

```text
tanglish_mixed_061
```

### Purpose

Verify that transliterated Tamil prompts written in English alphabets correctly trigger local-first routing and reminder retrieval logic.

### Example Prompt

```text
enna panra upcoming work tasks pathi?
```

### Verified Behavior

The assistant must:

* understand Tanglish phrasing
* route correctly to reminder retrieval
* call the correct local tool
* avoid unnecessary backend calls

### Expected Verification

```json
{
  "route": "calendar_query",
  "tools": ["listReminders"],
  "noBackendCall": true
}
```

### Why This Matters

This protects:

* local routing stability
* multilingual intent recognition
* transliterated Tamil handling
* offline assistant behavior

---

## 2. Native Tamil Response Validation

### Eval ID

```text
tamil_native_062
```

### Purpose

Ensure Tamil prompts generate Tamil-script responses and correctly retrieve reminders/tasks.

### Example Prompt

```text
நாளைக்கு என்ன மீட்டிங் இருக்கு?
```

### Verified Behavior

The assistant must:

* recognize Tamil input
* route to reminder retrieval
* return Tamil-script output
* avoid backend calls

### Language Verification

```json
{
  "language": "ta"
}
```

### Additional Validation

The eval runner verifies Tamil Unicode script using:

```ts
TAMIL_RE
```

### Why This Matters

This protects:

* Tamil assistant support
* multilingual orchestration
* local-language response generation
* Unicode-safe evaluation behavior

---

## 3. Memory Recall Validation

### Eval ID

```text
memory_recall_063
```

### Purpose

Validate assistant retrieval of stored user profile information without requiring a real multi-turn conversation.

### Injected Fixture

```json
{
  "project_code_name": "JAI-ORION"
}
```

### Expected Response

The assistant response must contain:

```text
JAI-ORION
```

### Verified Behavior

The assistant correctly:

* retrieves stored memory/profile facts
* accesses profile fixtures
* performs deterministic recall

### Why This Matters

This protects:

* profile memory logic
* memory recall orchestration
* assistant personalization stability

---

## 4. Clarification Safety Validation

### Eval ID

```text
clarify_vague_064
```

### Purpose

Ensure vague prompts trigger clarification behavior instead of unsafe destructive assumptions.

### Example Prompt

```text
Delete it
```

### Expected Behavior

The assistant must:

* avoid destructive guessing
* enter clarification mode
* request more information

### Route Verification

```json
{
  "route": "clarify",
  "isClarification": true
}
```

### Added Eval Logic

```ts
if (expected.isClarification && result.route !== "clarify")
```

### Why This Matters

This protects:

* destructive action safety
* ambiguity handling
* orchestration confidence logic
* user safety flows

---

## 5. Backend Fallback Validation

### Eval ID

```text
fallback_cloud_fail_065
```

### Purpose

Validate safe assistant fallback behavior when cloud/backend requests fail.

### New Mock Capability Added

```ts
simulateErrorFlag = true;
```

### Mocked Backend Failure

```ts
return {
  ok: false,
  status: 500
};
```

### Verified Behavior

The assistant must:

* avoid crashing
* provide a safe fallback response
* continue functioning locally
* surface user-friendly messaging

### New Eval Assertion

```ts
if (expected.isFallback)
```

### Why This Matters

This protects:

* offline-safe orchestration
* backend failure handling
* cloud degradation behavior
* local-first assistant resilience

---

# Eval Runner Improvements

## Case-Insensitive Matching

### Old Logic

```ts
text.includes(needle)
```

### New Logic

```ts
text.toLowerCase().includes(needle.toLowerCase())
```

### Benefits

* reduces false negatives
* stabilizes LLM verification
* improves Tanglish matching
* improves multilingual consistency

---

## Simulated Cloud Failure Support

Added deterministic failure injection:

```ts
simulateErrorFlag = true;
```

This enables:

* backend 500-error simulation
* local fallback validation
* offline orchestration testing

---

## Clarification Matcher Support

Added explicit clarification verification:

```ts
if (expected.isClarification && result.route !== "clarify")
```

This ensures vague prompts safely enter clarification mode.

---

## Fallback Matcher Support

Added explicit fallback verification:

```ts
if (expected.isFallback)
```

This validates local-safe fallback messaging during backend failure conditions.

---

## Memory Injection Support

Added support for fixture-based profile recall:

```ts
userProfile:
  (testCase.fixtures as any)?.profileAnswers
  || testCase.userProfile
```

This allows deterministic memory testing without requiring real multi-turn chat orchestration.

---

# Files Updated

## `mobile/data/evals/golden_assistant.json`

Added:

* Tanglish regression evals
* Tamil regression evals
* memory recall evals
* clarification evals
* backend fallback evals

---

## `mobile/test/goldenAssistant.eval.test.ts`

Added:

* clarification matcher
* fallback matcher
* simulated backend failure support
* case-insensitive matching
* profile memory injection support

---

# Verification Results

## Eval Verification

Executed:

```bash
npx vitest test/goldenAssistant.eval.test.ts
```

### Result

```text
46/46 mobile_local_agent eval cases passing
```

---

# Before vs After Impact

## Before

* mostly English-only eval coverage
* no Tanglish validation
* no fallback testing
* no clarification protection
* no memory recall validation
* fragile case-sensitive matching
* no backend failure simulation
* weak multilingual regression protection

---

## After

* deterministic multilingual eval coverage
* Tamil + Tanglish regression protection
* stronger local-first routing validation
* memory recall verification
* clarification-route protection
* backend/cloud fallback validation
* offline-safe orchestration testing
* safer assistant behavior validation
* more stable regression matching
* stronger QA confidence for multilingual AI flows

```
```

*Maintained by QA Automation Sprint Team*
*Last updated: 2026-05-13*
