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
  | { type: "WAKE_TRANSIENT_ERROR" }
  | { type: "WAKE_PERMANENT_ERROR" }
  | { type: "WAKE_DETECTED" }
  | { type: "COMMAND_STARTED" }
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

export const WAKE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export function wakeRetryDelayMs(attempt: number) {
  const index = Math.max(0, Math.floor(attempt));
  return WAKE_RETRY_DELAYS_MS[Math.min(index, WAKE_RETRY_DELAYS_MS.length - 1)];
}

export function isPermanentWakeError(error: { code?: string; message?: string } | Error | unknown) {
  const code = String((error as any)?.code || (error as any)?.name || "").toLowerCase();
  const message = String(
    (error as any)?.message || (error instanceof Error ? error.message : error || ""),
  ).toLowerCase();
  const value = `${code} ${message}`;
  return (
    value.includes("permission") ||
    value.includes("denied") ||
    value.includes("not-allowed") ||
    value.includes("unavailable") ||
    value.includes("unsupported") ||
    value.includes("not found") ||
    value.includes("missing") ||
    value.includes("not ready") ||
    code.includes("model")
  );
}

export function handsFreeStateReducer(
  snapshot: HandsFreeMachineSnapshot,
  event: HandsFreeEvent,
): HandsFreeMachineSnapshot {
  switch (event.type) {
    case "ELIGIBLE":
      return {
        ...snapshot,
        eligible: true,
        state:
          snapshot.wakeReady && (snapshot.state === "idle" || snapshot.state === "blocked")
            ? "wakeListening"
            : snapshot.state,
      };
    case "INELIGIBLE":
    case "VOICE_SHEET_CLOSED":
      return { ...snapshot, eligible: false, state: "idle" };
    case "WAKE_READY":
      return {
        ...snapshot,
        wakeReady: true,
        state:
          snapshot.eligible && (snapshot.state === "idle" || snapshot.state === "blocked")
            ? "wakeListening"
            : snapshot.state,
      };
    case "WAKE_MODEL_MISSING":
      return { ...snapshot, wakeReady: false, state: "blocked" };
    case "WAKE_STARTED":
      return snapshot.eligible && snapshot.wakeReady
        ? { ...snapshot, state: "wakeListening" }
        : snapshot;
    case "WAKE_TRANSIENT_ERROR":
      return snapshot.eligible && snapshot.wakeReady
        ? { ...snapshot, state: "wakeListening" }
        : { ...snapshot, state: "idle" };
    case "WAKE_PERMANENT_ERROR":
      return { ...snapshot, state: "blocked" };
    case "WAKE_DETECTED":
      return { ...snapshot, state: "wakeDetected" };
    case "COMMAND_STARTED":
      return { ...snapshot, state: "commandListening" };
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
