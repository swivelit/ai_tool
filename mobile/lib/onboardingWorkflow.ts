import type { LocalChatMessage } from "./localAgents";

export type OnboardingCompletionState =
  | "incomplete"
  | "complete_local_pending_sync"
  | "complete_synced"
  | "sync_failed";

export const STARTER_PROFILE_READY_MESSAGE =
  "Perfect. Your starter profile is ready. I’ll keep learning naturally as we chat.";

export function resolveCompletedOnboardingState(input: {
  localSyncState?: OnboardingCompletionState | null;
  profileQuestionnaireCompleted?: boolean | null;
}): OnboardingCompletionState {
  if (input.profileQuestionnaireCompleted || input.localSyncState === "complete_synced") {
    return "complete_synced";
  }
  if (input.localSyncState === "sync_failed") {
    return "sync_failed";
  }
  return "complete_local_pending_sync";
}

export function isOnboardingProfileComplete(input: {
  done: boolean;
  completionState: OnboardingCompletionState;
}) {
  return (
    input.done ||
    input.completionState === "complete_local_pending_sync" ||
    input.completionState === "complete_synced"
  );
}

export function shouldIgnoreOnboardingSend(input: {
  resolvedUserId: number | null;
  sending: boolean;
  done: boolean;
  completionState: OnboardingCompletionState;
  activeSlotId: string | null;
}) {
  if (!input.resolvedUserId || input.sending) return true;
  if (input.done) return true;
  if (
    input.completionState === "complete_synced" ||
    input.completionState === "complete_local_pending_sync"
  ) {
    return true;
  }
  return input.activeSlotId === null && input.done;
}

export function shouldIgnoreOnboardingOptionPress(input: {
  sending: boolean;
  done: boolean;
  completionState: OnboardingCompletionState;
}) {
  return (
    input.sending ||
    input.done ||
    input.completionState !== "incomplete"
  );
}

export function shouldShowOnboardingOptions(input: {
  done: boolean;
  completionState: OnboardingCompletionState;
  activeSlotId: string | null;
}) {
  return (
    !isOnboardingProfileComplete(input) &&
    input.completionState === "incomplete" &&
    Boolean(input.activeSlotId)
  );
}

function isProfileReadyMessage(content: unknown) {
  const text = String(content || "").toLowerCase();
  return (
    text.includes("starter profile is ready") ||
    text.includes("profile is already ready") ||
    /ஆரம்ப.*ப்ரொஃபைல்.*தயார்/.test(String(content || ""))
  );
}

export function sanitizeOnboardingHistory(history: LocalChatMessage[] = []) {
  const readyIndexes = history
    .map((message, index) =>
      message.role === "assistant" && isProfileReadyMessage(message.content)
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  if (!readyIndexes.length) return history;

  const firstReadyIndex = readyIndexes[0];
  const keepReadyIndex = readyIndexes[readyIndexes.length - 1];
  const finalReady = history[keepReadyIndex];
  return [
    ...history
      .slice(0, firstReadyIndex)
      .filter((message) => !isProfileReadyMessage(message.content)),
    finalReady,
  ];
}

export function ensureOnboardingReadyHistory(
  history: LocalChatMessage[] = [],
): LocalChatMessage[] {
  const sanitized = sanitizeOnboardingHistory(history);
  if (
    sanitized.some(
      (message) =>
        message.role === "assistant" && isProfileReadyMessage(message.content),
    )
  ) {
    return sanitized;
  }
  return [
    ...sanitized,
    {
      role: "assistant",
      content: STARTER_PROFILE_READY_MESSAGE,
      createdAt: new Date().toISOString(),
    },
  ];
}
