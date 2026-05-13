# QA APK Testing — Sprint Documentation

> [!IMPORTANT]
> This is a living document. Every code change made during this QA sprint will be recorded here with old/new state, rationale, and verification results.

---

## Table of Contents

1. [Phase 1 — Audit Summary](#phase-1--audit-summary)
2. [Task 3 — Chat Deletion UI Automation](#task-3--chat-deletion-ui-automation)
3. [Task 4 — Voice Button Automation](#task-4--voice-button-automation)
4. [Tasks 5 & 6 — Crash Scanner & Artifact Collection](#tasks-5--6--crash-scanner--artifact-collection) *(pending)*
5. [Task 7 — Golden Assistant Evals](#task-7--golden-assistant-evals) *(pending)*
6. [Tasks 8, 9 & 10 — CI, Reporting, Documentation](#tasks-8-9--10--ci-reporting-documentation) *(pending)*

---

## Phase 1 — Audit Summary

### Testing Stack Inventory

| Layer | Framework | Location | File Count |
|---|---|---|---|
| Mobile Unit/Integration | Vitest | `mobile/test/*.test.ts` | 31 test files |
| Backend | Pytest | `backend/tests/*.py` | 12 test files |
| APK UI E2E | Custom Bash + adb + Python XML | `test_apk.sh` | 1 file |

### APK Harness Architecture

The setup leverages a custom bash harness that uses `adb shell uiautomator dump` to parse the screen and `adb shell input tap/swipe` for interaction.

---

## Task 3 — Chat Deletion UI Automation

### 3.1 Implementation Details (Complete)

**Goal:** Automate the deletion of a chat session from the drawer history.

#### Accessibility Labels Added (`index.tsx`)
- `chat-history-item`: Added to the Pressable in the history list.
- `chat-delete-button`: Added to the Delete option in the action sheet.
- `chat-actions-cancel-button`: Added to the Cancel option.

#### Automation Sequence Added (`test_apk.sh`)
- **Step 1:** Open Drawer via `chat-drawer-button`.
- **Step 2:** Long-press `chat-history-item` (using 350ms hold).
- **Step 3:** Tap `chat-delete-button` in the action sheet.
- **Step 4:** Confirm in native Android Alert ("Delete chat").
- **Step 5:** Verify the item is removed from the drawer XML.

#### Verification Results
- Vitest assertion `chat drawer history items and action sheet expose automation labels` — ✅ **PASSED**
- Vitest assertion `verifies chat deletion automation is present in the APK test harness` — ✅ **PASSED**

---

## Task 4 — Voice Button Automation

### 4.1 Current Voice Interaction Flow (Analysis)

The voice system supports two distinct UI entry points:

#### Path A: Quick Mic (Inline Composer)
```
1. User taps "chat-mic-button" (mic icon in text input)
2. startRecording("quick") is called
3. UI displays <Waveform /> and "Recording voice message"
4. User taps "chat-mic-button" again (now shows a 'stop' icon)
5. stopAndAnalyze() is called
```

#### Path B: Live Orb (Modal Sheet)
```
1. User taps "chat-voice-button" (left of the text input)
2. voiceSheetOpen state becomes true, opening the Modal
3. User MUST Press-and-Hold the Orb component
4. startRecording("live") fires on onPressIn
5. User speaks while holding
6. User releases the Orb
7. stopAndAnalyze() fires on onPressOut
```

### 4.2 Voice UI States & Accessibility

| Element | testID / accessibilityLabel | Status |
|---|---|---|
| Voice Sheet Trigger | `chat-voice-button` | ✅ Present |
| Inline Mic Button | `chat-mic-button` | ✅ Present |
| Live Orb | *Dynamic (changes with state)* | ❌ **Needs static testID** |
| Thinking Indicator | `chat-thinking-indicator` | ✅ Present |
| Error/Success Message | `chat-assistant-response` | ✅ Present |
| Permission Alert | N/A (Android Native) | Needs text matching |

### 4.3 Proposed Automation Strategy

#### 1. Quick Mic Regression
- Tap `chat-mic-button`.
- Verify `wait_for_text "Recording voice message"`.
- Tap `chat-mic-button` again.
- Verify `wait_for_desc "chat-assistant-response"`.

#### 2. Live Orb Regression
- Tap `chat-voice-button`.
- Perform `adb shell input swipe X Y X Y 2000` on the Orb's coordinates (simulates 2s hold).
- Verify `wait_for_desc "chat-assistant-response"`.

### 4.4 Race Conditions & Timing Risks
- **Permission Delays**: Handle the "While using the app" native dialog.
- **Transcription Lag**: STT + LLM response can take 5-15 seconds.
- **Audio Settle Time**: Android requires ~300ms before it can reliably stop recording.

---

## Change Log

| Date | File | Change | Status |
|---|---|---|---|
| 2026-05-13 | `mobile/app/(chat)/index.tsx` | Add accessibility labels (Task 3) | ✅ Complete |
| 2026-05-13 | `test_apk.sh` | Add chat deletion automation (Task 3) | ✅ Complete |
| 2026-05-13 | `mobile/test/apkHarness.test.ts` | Add Vitest assertions (Task 3) | ✅ Complete |
| 2026-05-13 | `qa_apk_testing.md` | Task 4 Voice Flow Analysis | ✅ Complete |
| — | `mobile/components/Orb.tsx` | Add static `voice-orb` testID | ⏳ Pending |
| — | `mobile/app/(chat)/index.tsx` | Add Voice Modal accessibility labels | ⏳ Pending |
| — | `test_apk.sh` | Add Quick Mic & Live Orb automation | ⏳ Pending |
| — | `mobile/test/apkHarness.test.ts` | Add Vitest assertions for voice labels | ⏳ Pending |

---

*Document maintained by QA Automation Sprint Team*
*Last updated: 2026-05-13*
