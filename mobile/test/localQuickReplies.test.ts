import { describe, expect, it } from "vitest";

import { tryBuildQuickLocalReply } from "../lib/localQuickReplies";

describe("local quick replies", () => {
  it.each([
    ["who are you?", "identity"],
    ["can you help me?", "capabilities"],
    ["i feel anxious", "wellbeing_support"],
    ["vanakkam", "fast_greeting"],
    ["What are you up to?", "small_talk"],
    ["what are you doing", "small_talk"],
    ["are you there?", "small_talk"],
    ["what can you do?", "capabilities"],
    ["I’m feeling so tired!", "wellbeing_support"],
  ])("routes %s to %s", (message, route) => {
    expect(tryBuildQuickLocalReply({ message })?.route).toBe(route);
  });

  it.each([
    "what are you doing with my reminders tomorrow",
    "remind me tomorrow",
    "what is the weather tomorrow",
    "summarize this",
    "write code for me",
  ])("does not quick-route task prompt: %s", (message) => {
    expect(tryBuildQuickLocalReply({ message })).toBeNull();
  });

  it("personalizes identity and greeting replies from cheap profile context", () => {
    const identity = tryBuildQuickLocalReply({
      message: "who are you?",
      assistantName: "Kani",
    });
    const greeting = tryBuildQuickLocalReply({
      message: "vanakkam",
      userName: "Hari",
    });

    expect(identity?.assistantText).toContain("Kani");
    expect(greeting?.assistantText).toContain("Hari");
  });
});
