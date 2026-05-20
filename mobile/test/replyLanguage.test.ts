import { describe, expect, it } from "vitest";

import {
  detectMessageReplyLanguage,
  resolveReplyLanguage,
  resolveVoiceLanguageParams,
} from "../lib/replyLanguage";

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

  it("lets Settings English win over Tamil or Tanglish input", () => {
    expect(
      resolveReplyLanguage({
        settings: "en",
        profile: "ta",
        message: "நாளைக்கு என்ன plan?",
      }),
    ).toBe("en");
    expect(
      resolveReplyLanguage({
        settings: "en",
        profile: "ta",
        message: "idha simple ah sollu",
      }),
    ).toBe("en");
  });

  it("lets Settings Tamil win over English input", () => {
    expect(
      resolveReplyLanguage({
        settings: "ta",
        profile: "en",
        message: "Explain recursion",
      }),
    ).toBe("ta");
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
        settings: "ta",
        profile: "ta",
        message: "English la sollu: how do I improve my resume?",
      }),
    ).toBe("en");
    expect(
      resolveReplyLanguage({
        settings: "en",
        profile: "en",
        message: "தமிழில் சொல்லு",
      }),
    ).toBe("ta");
  });

  it("uses cached profile only when Settings is missing", () => {
    expect(
      resolveReplyLanguage({
        profile: "en",
        message: "idha simple ah sollu",
      }),
    ).toBe("en");
  });

  it("uses product default only after explicit, Settings, profile, and detection", () => {
    expect(
      resolveReplyLanguage({
        message: "idha simple ah sollu",
        productDefault: "ta",
      }),
    ).toBe("ta");
  });

  it("resolves voice language params from Settings and keeps STT autodetect by default", () => {
    expect(
      resolveVoiceLanguageParams({
        settingsLanguageMode: "en",
        profileReplyLanguage: "ta",
      }),
    ).toEqual({
      replyLanguage: "en",
      speechLanguage: "auto",
      ttsLanguageCode: "en-IN",
    });
  });
});
