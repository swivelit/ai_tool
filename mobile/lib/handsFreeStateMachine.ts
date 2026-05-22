export type HandsFreeState =
  | "idle"
  | "wakeListening"
  | "wakeDetected"
  | "commandListening"
  | "submitting"
  | "speaking"
  | "recording"
  | "stopping"
  | "blocked";

export type HandsFreeEvent =
  | { type: "ELIGIBLE" }
  | { type: "INELIGIBLE" }
  | { type: "WAKE_READY" }
  | { type: "WAKE_MODEL_MISSING" }
  | { type: "WAKE_STARTED" }
  | { type: "WAKE_DETECTED" }
  | { type: "COMMAND_FINAL" }
  | { type: "COMMAND_EMPTY" }
  | { type: "SUBMIT_STARTED" }
  | { type: "SUBMIT_FINISHED" }
  | { type: "TTS_STARTED" }
  | { type: "TTS_COMPLETED" }
  | { type: "PRESS_TO_TALK_STARTED" }
  | { type: "PRESS_TO_TALK_FINISHED" }
  | { type: "VOICE_SHEET_CLOSED" }
  | { type: "ERROR" }
  | { type: "STOP_COMMAND" };

export type HandsFreeMachineSnapshot = {
  state: HandsFreeState;
  eligible: boolean;
  wakeReady: boolean;
};

export const initialHandsFreeMachineState: HandsFreeMachineSnapshot = {
  state: "idle",
  eligible: false,
  wakeReady: false,
};

export function handsFreeStateReducer(
  snapshot: HandsFreeMachineSnapshot,
  event: HandsFreeEvent,
): HandsFreeMachineSnapshot {
  switch (event.type) {
    case "ELIGIBLE":
      return {
        ...snapshot,
        eligible: true,
        state: snapshot.wakeReady && snapshot.state === "idle" ? "wakeListening" : snapshot.state,
      };
    case "INELIGIBLE":
    case "VOICE_SHEET_CLOSED":
      return { ...snapshot, eligible: false, state: "idle" };
    case "WAKE_READY":
      return {
        ...snapshot,
        wakeReady: true,
        state: snapshot.eligible && snapshot.state === "idle" ? "wakeListening" : snapshot.state,
      };
    case "WAKE_MODEL_MISSING":
      return { ...snapshot, wakeReady: false, state: "blocked" };
    case "WAKE_STARTED":
      return snapshot.eligible && snapshot.wakeReady
        ? { ...snapshot, state: "wakeListening" }
        : snapshot;
    case "WAKE_DETECTED":
      return { ...snapshot, state: "wakeDetected" };
    case "COMMAND_FINAL":
      return { ...snapshot, state: "submitting" };
    case "COMMAND_EMPTY":
    case "SUBMIT_FINISHED":
    case "TTS_COMPLETED":
    case "PRESS_TO_TALK_FINISHED":
    case "STOP_COMMAND":
      return {
        ...snapshot,
        state: snapshot.eligible && snapshot.wakeReady ? "wakeListening" : "idle",
      };
    case "SUBMIT_STARTED":
      return { ...snapshot, state: "submitting" };
    case "TTS_STARTED":
      return { ...snapshot, state: "speaking" };
    case "PRESS_TO_TALK_STARTED":
      return { ...snapshot, state: "recording" };
    case "ERROR":
      return { ...snapshot, state: "blocked" };
    default:
      return snapshot;
  }
}

export function isHandsFreeWakeEligible(input: {
  handsFreeEnabled: boolean;
  appState: string;
  voiceSheetOpen: boolean;
  wakeModelReady: boolean;
}) {
  return (
    input.handsFreeEnabled === true &&
    input.appState === "active" &&
    input.voiceSheetOpen === true &&
    input.wakeModelReady === true
  );
}
