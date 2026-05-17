import { describe, expect, it } from "vitest";

import { normalizeChatResponse, normalizeChatTurnPayload } from "@/lib/chatResponse";

describe("chat response normalization", () => {
  it("preserves nested backend reminder fields", () => {
    const normalized = normalizeChatResponse(
      {
        ok: true,
        item: {
          id: 42,
          intent: "reminder",
          category: "Work",
          raw_text: "remind me about standup",
          transcript: "remind me about standup",
          datetime: "2026-05-01T09:00:00",
          title: "Standup",
          details: "I will remind you about Standup.",
          created_at: "2026-04-26T12:00:00Z",
          source: "voice",
        },
        assistant: {
          text: "I will remind you about Standup.",
          english: "I will remind you about Standup.",
        },
      },
      ""
    );

    expect(normalized.intent).toBe("reminder");
    expect(normalized.datetime).toBe("2026-05-01T09:00:00");
    expect(normalized.title).toBe("Standup");
    expect(normalized.source).toBe("voice");
  });

  it("keeps legacy flat voice payloads usable", () => {
    const normalized = normalizeChatTurnPayload(
      {
        id: 7,
        intent: "reminder",
        category: "Other",
        raw_text: "remind me to drink water",
        transcript: "remind me to drink water",
        datetime: "tomorrow 8 AM",
        title: "Drink water",
        details: "Okay, I can remind you.",
        source: "voice",
      },
      "remind me to drink water"
    );

    expect(normalized.id).toBe(7);
    expect(normalized.intent).toBe("reminder");
    expect(normalized.datetime).toBe("tomorrow 8 AM");
    expect(normalized.details).toBe("Okay, I can remind you.");
  });

  it("falls back to assistant text when no item is present", () => {
    const normalized = normalizeChatResponse(
      {
        ok: true,
        assistant: {
          text: "Assistant reply",
        },
      },
      "hello"
    );

    expect(normalized.intent).toBe("assistant");
    expect(normalized.raw_text).toBe("hello");
    expect(normalized.details).toBe("Assistant reply");
  });

  it("marks local chat proxy responses as local origin", () => {
    const normalized = normalizeChatTurnPayload(
      {
        ok: true,
        item: {
          id: 99,
          intent: "assistant",
          category: "Other",
          raw_text: "hello",
          details: "Local reply",
          source: "text",
        },
        assistant: { text: "Local reply" },
        meta: { source: "local_quick_reply" },
      },
      "hello",
    );

    expect(normalized.__origin).toBe("local");
  });
});
