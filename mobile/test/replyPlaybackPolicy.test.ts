import { describe, expect, it } from "vitest";

import {
  shouldAutoSpeakReply,
  normalizeReplyLanguage,
} from "../lib/replyPlaybackPolicy";

describe("reply playback policy", () => {
  it("keeps text chat silent by default", () => {
    expect(shouldAutoSpeakReply({ source: "text" })).toBe(false);
  });

  it("auto speaks voice replies when enabled", () => {
  expect(
    shouldAutoSpeakReply({
      source: "voice",
      autoSpeakReplies: true,
      handsFreeMode: "off",
    }),
  ).toBe(true);

  expect(
    shouldAutoSpeakReply({
      source: "voice",
      autoSpeakReplies: false,
      handsFreeMode: "off",
    }),
  ).toBe(false);
});

  it("always auto speaks hands-free replies", () => {
  expect(
    shouldAutoSpeakReply({
      source: "handsfree",
      handsFreeMode: "wake",
      autoSpeakReplies: false,
    }),
  ).toBe(true);

  expect(
    shouldAutoSpeakReply({
      source: "handsfree",
      handsFreeMode: "command",
      autoSpeakReplies: false,
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

  it("prevents duplicate playback for same replyId", () => {

  const first = shouldAutoSpeakReply({
    source: "voice",
    autoSpeakReplies: true,
    replyId: "reply-1",
  });

  const second = shouldAutoSpeakReply({
    source: "voice",
    autoSpeakReplies: true,
    replyId: "reply-1",
  });

  expect(first).toBe(true);
  expect(second).toBe(false);
});

it("allows playback for different replyIds", () => {

  const first = shouldAutoSpeakReply({
    source: "voice",
    autoSpeakReplies: true,
    replyId: "reply-1",
  });

  const second = shouldAutoSpeakReply({
    source: "voice",
    autoSpeakReplies: true,
    replyId: "reply-2",
  });

  expect(first).toBe(true);
  expect(second).toBe(true);
});

it("does not auto-play normal text chat", () => {

  const result = shouldAutoSpeakReply({
    source: "text",
    autoSpeakReplies: true,
    replyId: "reply-3",
  });

  expect(result).toBe(false);
});
});