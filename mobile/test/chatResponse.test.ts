import { describe, expect, it } from "vitest";

import { normalizeChatResponse, normalizeChatTurnPayload } from "@/lib/chatResponse";
import { generateLocalChatItemId, mergeChatHistoryItems } from "@/lib/chatHistory";

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

// ---------------------------------------------------------------------------
// New: error-state and multi-turn normalization tests
// ---------------------------------------------------------------------------

describe("chat response error-state handling", () => {
  it("failed second turn item does not overwrite first turn details in merge", () => {
    const turn1 = normalizeChatTurnPayload(
      {
        ok: true,
        item: {
          id: 1111,
          intent: "assistant",
          category: "Other",
          raw_text: "first question",
          details: "First answer.",
          source: "text",
          __origin: "backend",
        } as any,
        assistant: { text: "First answer." },
      },
      "first question"
    );

    // Simulate a failed second turn: no item returned, we keep history
    // unchanged — mergeChatHistoryItems with only turn1 must be stable.
    const historyAfterTurn1 = mergeChatHistoryItems([turn1]);
    const historyAfterFailedTurn2 = mergeChatHistoryItems(historyAfterTurn1);

    expect(historyAfterFailedTurn2).toHaveLength(1);
    expect(historyAfterFailedTurn2[0].details).toBe("First answer.");
  });

  it("normalizing with a pre-allocated local ID survives merge with real backend item", () => {
    const localId = generateLocalChatItemId();

    // Step 1: local placeholder with negative ID
    const placeholder = normalizeChatTurnPayload(
      {
        ok: true,
        item: {
          id: localId,
          intent: "assistant",
          category: "Other",
          raw_text: "my question",
          details: "Thinking…",
          source: "text",
          __origin: "local",
        } as any,
        assistant: { text: "Thinking…" },
      },
      "my question"
    );

    // Step 2: backend resolves with a real positive ID
    const backendItem = normalizeChatTurnPayload(
      {
        ok: true,
        item: {
          id: 99999,
          intent: "assistant",
          category: "Other",
          raw_text: "my question",
          details: "Real answer.",
          source: "text",
          __origin: "backend",
        } as any,
        assistant: { text: "Real answer." },
      },
      "my question"
    );

    // Merge: drop placeholder, keep real item
    const withoutPlaceholder = [placeholder].filter((i) => i.id !== localId);
    const merged = mergeChatHistoryItems(withoutPlaceholder, [backendItem]);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(99999);
    expect(merged[0].details).toBe("Real answer.");
  });
});
