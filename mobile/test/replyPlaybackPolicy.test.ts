import { describe, expect, it } from "vitest";

import { shouldAutoSpeakReply } from "../lib/replyPlaybackPolicy";

describe("reply playback policy", () => {
  it("keeps text chat silent by default", () => {
    expect(shouldAutoSpeakReply({ source: "text" })).toBe(false);
  });

  it("does not auto-speak non-live voice sources", () => {
    expect(shouldAutoSpeakReply({ source: "voice", voiceSurface: "quick" })).toBe(false);
  });

  it("speaks live voice replies by default", () => {
    expect(shouldAutoSpeakReply({ source: "voice", voiceSurface: "live" })).toBe(true);
  });

  it("does not use voice-only mode to auto-speak a non-live source", () => {
    expect(
      shouldAutoSpeakReply({
        source: "voice",
        voiceSurface: "quick",
        voiceOnlyMode: true,
      }),
    ).toBe(false);
  });

  it("keeps non-live voice silent even when auto-speak replies is enabled", () => {
    expect(
      shouldAutoSpeakReply({
        source: "voice",
        voiceSurface: "quick",
        autoSpeakReplies: true,
      }),
    ).toBe(false);
  });

  it("keeps hands-free silent by default", () => {
    expect(
      shouldAutoSpeakReply({ source: "handsfree", handsFreeMode: "wake" }),
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
});
