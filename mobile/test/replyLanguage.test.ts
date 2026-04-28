import { describe, expect, it } from "vitest";

import { detectMessageReplyLanguage, resolveReplyLanguage } from "../lib/replyLanguage";

describe("reply language selection", () => {
  it("detects mostly English text as English", () => {
    expect(detectMessageReplyLanguage("Explain recursion with an example")).toBe("en");
  });

  it("detects Tamil script as Tamil", () => {
    expect(detectMessageReplyLanguage("நாளைக்கு என்ன செய்யலாம்?")).toBe("ta");
  });

  it("uses profile preference for mixed Tanglish text", () => {
    expect(
      resolveReplyLanguage({
        profile: "en",
        message: "idha simple ah sollu",
      }),
    ).toBe("en");
  });

  it("uses product default for mixed Tanglish text without profile preference", () => {
    expect(
      resolveReplyLanguage({
        message: "idha simple ah sollu",
        productDefault: "ta",
      }),
    ).toBe("ta");
  });

  it("honors practical in-message language requests over profile preference", () => {
    expect(
      resolveReplyLanguage({
        profile: "ta",
        message: "English la sollu: how do I improve my resume?",
      }),
    ).toBe("en");
    expect(
      resolveReplyLanguage({
        profile: "en",
        message: "தமிழில் சொல்லு",
      }),
    ).toBe("ta");
  });
});
