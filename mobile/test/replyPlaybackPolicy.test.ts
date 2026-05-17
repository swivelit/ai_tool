import { describe, expect, it } from "vitest";

import {
  shouldAutoSpeakReply,
  normalizeReplyLanguage,
} from "../lib/replyPlaybackPolicy";

describe("reply playback policy", () => {
  it("keeps text chat silent by default", () => {
    expect(shouldAutoSpeakReply({ source: "text" })).toBe(false);
  });

  it("keeps normal recorded voice silent by default", () => {
    expect(shouldAutoSpeakReply({ source: "voice" })).toBe(false);
  });

  it("keeps hands-free silent by default", () => {
    expect(
      shouldAutoSpeakReply({
        source: "handsfree",
        handsFreeMode: "wake",
      }),
    ).toBe(false);
  });

  it("allows hands-free auto-speak only with an explicit setting", () => {
    expect(
      shouldAutoSpeakReply({
        source: "handsfree",
        handsFreeMode: "wake",
        autoSpeakReplies: true,
      }),
    ).toBe(true);

    expect(
      shouldAutoSpeakReply({
        source: "handsfree",
        handsFreeMode: "off",
        autoSpeakReplies: true,
      }),
    ).toBe(false);
  });

  it("supports english reply language", () => {
    expect(normalizeReplyLanguage("english")).toBe("english");
  });

  it("supports tamil reply language", () => {
    expect(normalizeReplyLanguage("tamil")).toBe("tamil");
  });

  it("supports tanglish reply language", () => {
    expect(normalizeReplyLanguage("tanglish")).toBe("tanglish");
  });

  it("defaults invalid language to auto", () => {
    expect(normalizeReplyLanguage("invalid")).toBe("auto");
  });
});