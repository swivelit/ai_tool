import { describe, expect, it } from "vitest";

import {
  handsFreeStateReducer,
  initialHandsFreeMachineState,
  isHandsFreeWakeEligible,
} from "@/lib/handsFreeStateMachine";

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
    state = handsFreeStateReducer(state, { type: "COMMAND_FINAL" });
    expect(state.state).toBe("submitting");
    state = handsFreeStateReducer(state, { type: "TTS_STARTED" });
    expect(state.state).toBe("speaking");
    state = handsFreeStateReducer(state, { type: "TTS_COMPLETED" });
    expect(state.state).toBe("wakeListening");
  });
});
