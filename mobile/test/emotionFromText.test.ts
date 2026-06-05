import { describe, expect, it } from "vitest";

import { emotionFromText } from "../lib/emotionFromText";

describe("emotionFromText", () => {
  it("keeps empty or low-signal replies neutral", () => {
    expect(emotionFromText("")).toBe("neutral");
    expect(emotionFromText("The file is in your documents folder.")).toBe("neutral");
  });

  it("detects positive and excited replies", () => {
    expect(emotionFromText("Sure, I can do that.")).toBe("happy");
    expect(emotionFromText("Amazing, great job!!")).toBe("excited");
  });

  it("prioritizes concern over positive wording", () => {
    expect(emotionFromText("Sorry, I found a great option but it failed.")).toBe("concerned");
  });

  it("detects thinking or uncertain replies", () => {
    expect(emotionFromText("Let me think. It depends on your schedule?")).toBe("thinking");
  });

  it("detects surprised replies from words, emoji, and punctuation", () => {
    expect(emotionFromText("Wow, I did not expect that?!")).toBe("surprised");
    expect(emotionFromText("That is new 🤯")).toBe("surprised");
  });

  it("detects sad replies separately from warnings or errors", () => {
    expect(emotionFromText("That sounds hard. I am sad this happened.")).toBe("sad");
    expect(emotionFromText("Warning: that failed, sorry.")).toBe("concerned");
  });
});
