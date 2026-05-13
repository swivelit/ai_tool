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
* no stable selectors existed

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

# Pending Tasks

## Tasks 5 & 6

* Crash scanner improvements
* Artifact collection improvements

## Task 7

* Golden eval improvements
* Tamil/Tanglish coverage

## Tasks 8, 9 & 10

* CI integration
* readable QA reports
* local QA documentation

---

# Final Sprint Impact

## Before Sprint

* partial APK automation
* weak regression validation
* limited selectors
* manual voice testing
* manual deletion testing

---

# After Sprint

* stronger APK automation
* stable regression selectors
* automated deletion testing
* automated voice testing
* improved verification reliability
* improved QA confidence

---

*Maintained by QA Automation Sprint Team*
