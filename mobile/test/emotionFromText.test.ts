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
});
