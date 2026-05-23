import { describe, expect, it } from "vitest";

import {
  handsFreeStateReducer,
  initialHandsFreeMachineState,
  isPermanentWakeError,
  isHandsFreeWakeEligible,
  WAKE_RETRY_DELAYS_MS,
  wakeRetryDelayMs,
} from "@/lib/handsFreeStateMachine";
import {
  buildCommandRecognitionLocalePlan,
  isLanguageNotSupportedRecognitionError,
} from "@/lib/handsFreeCommandLocales";

describe("handsFreeStateMachine", () => {
  it("only marks hands-free eligible while app is active, voice is open, and model is ready", () => {
    expect(
      isHandsFreeWakeEligible({
        handsFreeEnabled: true,
        appState: "active",
        voiceSheetOpen: true,
        wakeModelReady: true,
      }),
    ).toBe(true);
    expect(
      isHandsFreeWakeEligible({
        handsFreeEnabled: true,
        appState: "background",
        voiceSheetOpen: true,
        wakeModelReady: true,
      }),
    ).toBe(false);
    expect(
      isHandsFreeWakeEligible({
        handsFreeEnabled: true,
        appState: "active",
        voiceSheetOpen: false,
        wakeModelReady: true,
      }),
    ).toBe(false);
  });

  it("moves from native wake listening through command, submit, TTS, then back to wake", () => {
    let state = handsFreeStateReducer(initialHandsFreeMachineState, { type: "WAKE_READY" });
    state = handsFreeStateReducer(state, { type: "ELIGIBLE" });
    expect(state.state).toBe("wakeListening");
    state = handsFreeStateReducer(state, { type: "WAKE_DETECTED" });
    expect(state.state).toBe("wakeDetected");
    state = handsFreeStateReducer(state, { type: "COMMAND_STARTED" });
    expect(state.state).toBe("commandListening");
    state = handsFreeStateReducer(state, { type: "COMMAND_FINAL" });
    expect(state.state).toBe("submitting");
    state = handsFreeStateReducer(state, { type: "TTS_STARTED" });
    expect(state.state).toBe("speaking");
    state = handsFreeStateReducer(state, { type: "TTS_COMPLETED" });
    expect(state.state).toBe("wakeListening");
  });

  it("does not become active when the wake model is missing", () => {
    let state = handsFreeStateReducer(initialHandsFreeMachineState, { type: "ELIGIBLE" });
    state = handsFreeStateReducer(state, { type: "WAKE_MODEL_MISSING" });

    expect(state.wakeReady).toBe(false);
    expect(state.state).toBe("blocked");
  });

  it("keeps transient wake errors retryable and blocks permanent wake errors", () => {
    let state = handsFreeStateReducer(initialHandsFreeMachineState, { type: "WAKE_READY" });
    state = handsFreeStateReducer(state, { type: "ELIGIBLE" });
    state = handsFreeStateReducer(state, { type: "WAKE_TRANSIENT_ERROR" });
    expect(state.state).toBe("wakeListening");

    state = handsFreeStateReducer(state, { type: "WAKE_PERMANENT_ERROR" });
    expect(state.state).toBe("blocked");

    expect(WAKE_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000, 8000]);
    expect(wakeRetryDelayMs(0)).toBe(1000);
    expect(wakeRetryDelayMs(2)).toBe(4000);
    expect(wakeRetryDelayMs(99)).toBe(8000);
    expect(isPermanentWakeError({ code: "JAI_WAKE_AUDIO_START_FAILED", message: "AudioRecord busy" })).toBe(false);
    expect(isPermanentWakeError({ code: "JAI_WAKE_MODEL_UNSUPPORTED", message: "bad shape" })).toBe(true);
    expect(isPermanentWakeError({ message: "microphone permission denied" })).toBe(true);
    expect(isPermanentWakeError({ message: "Native wake-word detection is unavailable." })).toBe(true);
  });

  it("falls command recognition back from Tamil/Indian English to English once", () => {
    expect(buildCommandRecognitionLocalePlan("ta-IN")).toEqual(["ta-IN", "en-IN", "en-US"]);
    expect(buildCommandRecognitionLocalePlan("en-IN")).toEqual(["en-IN", "en-US"]);
    expect(isLanguageNotSupportedRecognitionError({ error: "language-not-supported" })).toBe(true);
  });
});
