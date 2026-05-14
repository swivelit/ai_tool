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
    ["Do you know about ipl?", "knowledge_ack"],
    ["have you heard about IPL?", "knowledge_ack"],
  ])("routes %s to %s", (message, route) => {
    expect(tryBuildQuickLocalReply({ message })?.route).toBe(route);
  });

  it.each([
    "what are you doing with my reminders tomorrow",
    "remind me tomorrow",
    "what is the weather tomorrow",
    "summarize this",
    "write code for me",
    "latest IPL score today",
    "do you know about latest IPL score today",
  ])("does not quick-route task prompt: %s", (message) => {
    expect(tryBuildQuickLocalReply({ message })).toBeNull();
  });

  it("answers IPL knowledge acknowledgement locally", () => {
    const reply = tryBuildQuickLocalReply({ message: "Do you know about IPL?" });

    expect(reply?.source).toBe("local_rules");
    expect(reply?.route).toBe("knowledge_ack");
    expect(reply?.assistantText).toContain("Indian Premier League");
    expect(reply?.assistantText).toContain("T20 cricket");
  });

  it("returns a Tamil IPL acknowledgement when requested", () => {
    const reply = tryBuildQuickLocalReply({
      message: "Do you know about IPL?",
      replyLanguage: "ta",
    });

    expect(reply?.route).toBe("knowledge_ack");
    expect(reply?.assistantText).toContain("Indian Premier League");
    expect(reply?.assistantText).toContain("Live scores");
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
