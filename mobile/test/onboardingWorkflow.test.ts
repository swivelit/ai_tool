import { describe, expect, it } from "vitest";

import {
  ensureOnboardingReadyHistory,
  resolveCompletedOnboardingState,
  sanitizeOnboardingHistory,
  shouldIgnoreOnboardingOptionPress,
  shouldIgnoreOnboardingSend,
  shouldShowOnboardingOptions,
} from "../lib/onboardingWorkflow";

describe("onboarding workflow guards", () => {
  it("does not render option chips when the starter profile is done", () => {
    expect(
      shouldShowOnboardingOptions({
        done: true,
        completionState: "complete_synced",
        activeSlotId: "work_rhythm",
      }),
    ).toBe(false);
  });

  it("ignores late single-option presses after completion", () => {
    expect(
      shouldIgnoreOnboardingOptionPress({
        sending: false,
        done: true,
        completionState: "complete_synced",
      }),
    ).toBe(true);
  });

  it("ignores typed sends while completion is pending or synced", () => {
    expect(
      shouldIgnoreOnboardingSend({
        resolvedUserId: 7,
        sending: false,
        done: true,
        completionState: "complete_local_pending_sync",
        activeSlotId: null,
      }),
    ).toBe(true);
  });

  it("keeps only one final starter profile ready message", () => {
    const history = sanitizeOnboardingHistory([
      { role: "assistant", content: "Perfect. Your starter profile is ready.", createdAt: "1" },
      { role: "user", content: "Afternoon", createdAt: "2" },
      { role: "assistant", content: "Perfect. Your starter profile is ready.", createdAt: "3" },
    ]);

    expect(
      history.filter((message) =>
        message.content.includes("starter profile is ready"),
      ),
    ).toHaveLength(1);
    expect(history.some((message) => message.content === "Afternoon")).toBe(false);
    expect(history.at(-1)?.content).toContain("starter profile is ready");
  });

  it("treats completed backend/local profile as synced even when local sync state is missing", () => {
    expect(
      resolveCompletedOnboardingState({
        localSyncState: undefined,
        profileQuestionnaireCompleted: true,
      }),
    ).toBe("complete_synced");
  });

  it("keeps completed unknown sync state pending for one automatic sync attempt", () => {
    expect(
      resolveCompletedOnboardingState({
        localSyncState: undefined,
        profileQuestionnaireCompleted: false,
      }),
    ).toBe("complete_local_pending_sync");
  });

  it("surfaces failed completed-profile sync as retryable", () => {
    expect(
      resolveCompletedOnboardingState({
        localSyncState: "sync_failed",
        profileQuestionnaireCompleted: false,
      }),
    ).toBe("sync_failed");
  });

  it("creates one ready message when completed history is empty", () => {
    const history = ensureOnboardingReadyHistory([]);

    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("assistant");
    expect(history[0].content).toContain("starter profile is ready");
    expect(
      shouldShowOnboardingOptions({
        done: true,
        completionState: "complete_synced",
        activeSlotId: null,
      }),
    ).toBe(false);
  });
});
