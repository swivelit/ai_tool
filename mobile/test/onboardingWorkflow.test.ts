import { describe, expect, it } from "vitest";

import {
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
});
