import { describe, expect, it } from "vitest";

import { tryBuildQuickLocalReply } from "../lib/localQuickReplies";

describe("local quick replies", () => {
  it.each([
    ["What are you up to?", "small_talk"],
    ["what are you doing", "small_talk"],
    ["are you there?", "small_talk"],
    ["what can you do?", "capabilities"],
    ["I’m feeling so tired!", "wellbeing_support"],
  ])("routes %s to %s", (message, route) => {
    expect(tryBuildQuickLocalReply({ message })?.route).toBe(route);
  });

  it("does not turn a task prompt into generic small talk", () => {
    expect(
      tryBuildQuickLocalReply({
        message: "what are you doing with my reminders tomorrow",
      }),
    ).toBeNull();
  });
});
