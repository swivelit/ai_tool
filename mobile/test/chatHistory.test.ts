import { describe, expect, it, vi } from "vitest";

import {
  classifyChatHistoryItemsForDeletion,
  createChatSessionFromItem,
  filterHistoryItemsByHiddenItemIds,
  filterLocalChatHistoryItems,
  getChatHistoryItemKind,
  markChatHistoryItemsOrigin,
  mergeChatHistoryItems,
  reconcileChatSessions,
} from "@/lib/chatHistory";
import { ChatHistoryItem, normalizeChatTurnPayload } from "@/lib/chatResponse";

function item(
  id: number,
  rawText: string,
  origin: ChatHistoryItem["__origin"],
): ChatHistoryItem {
  return {
    id,
    intent: "assistant",
    category: "Other",
    raw_text: rawText,
    details: `${rawText} answer`,
    created_at: `2026-05-12T00:00:0${id}Z`,
    source: "text",
    __origin: origin,
  };
}

describe("chat history merge", () => {
  it("preserves existing local-only turns when backend items are empty and a second local turn is added", () => {
    const firstLocal = item(1001, "first question", "local");
    const secondLocal = item(1002, "second question", "local");

    const merged = mergeChatHistoryItems([firstLocal], [firstLocal], [], [secondLocal]);

    expect(merged.map((entry) => entry.raw_text)).toEqual([
      "second question",
      "first question",
    ]);
    expect(filterLocalChatHistoryItems(merged).map((entry) => entry.id)).toEqual([
      1002,
      1001,
    ]);
  });

  it("marks backend API items with backend origin", () => {
    const [backendItem] = markChatHistoryItemsOrigin(
      [item(7, "saved question", undefined)],
      "backend",
    );

    expect(backendItem.__origin).toBe("backend");
  });

  it("keeps backend OpenAI fallback answers visible as backend history", () => {
    const fallbackItem = normalizeChatTurnPayload(
      {
        ok: true,
        item: {
          id: 8801,
          intent: "assistant",
          category: "Other",
          raw_text: "Do you know about ipl ?",
          details: "Backend IPL answer.",
          source: "text",
          __origin: "backend",
        } as any,
        assistant: { text: "Backend IPL answer." },
        meta: {
          source: "backend_openai_fallback",
          fallback_reason: "local_timeout",
        },
      },
      "Do you know about ipl ?",
    );
    const merged = mergeChatHistoryItems([], [], [fallbackItem]);

    expect(merged).toHaveLength(1);
    expect(merged[0].details).toBe("Backend IPL answer.");
    expect(merged[0].__origin).toBe("backend");
  });
});

describe("chat deletion classification", () => {
  it("removes local-only items locally without calling backend delete", () => {
    const apiDelete = vi.fn();
    const selectedItems = [item(2001, "local only", "local")];
    const groups = classifyChatHistoryItemsForDeletion(selectedItems);
    const remaining = filterHistoryItemsByHiddenItemIds(selectedItems, new Set(groups.allItemIds));

    groups.backendItemIds.forEach((itemId) => apiDelete(`/items/${itemId}`));

    expect(groups.localItemIds).toEqual([2001]);
    expect(groups.backendItemIds).toEqual([]);
    expect(remaining).toEqual([]);
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it("calls backend delete only for backend-origin items", () => {
    const apiDelete = vi.fn();
    const groups = classifyChatHistoryItemsForDeletion([
      item(3001, "backend", "backend"),
      item(3002, "local", "local"),
    ]);

    groups.backendItemIds.forEach((itemId) => apiDelete(`/items/${itemId}`));

    expect(groups.backendItemIds).toEqual([3001]);
    expect(groups.localItemIds).toEqual([3002]);
    expect(apiDelete).toHaveBeenCalledWith("/items/3001");
    expect(apiDelete).toHaveBeenCalledTimes(1);
  });

  it("hidden IDs prevent deleted local items from rehydrating", () => {
    const storedLocal = item(4001, "deleted local", "local");
    const currentLocal = item(4002, "visible local", "local");
    const merged = mergeChatHistoryItems([currentLocal], [storedLocal], [], []);
    const visible = filterHistoryItemsByHiddenItemIds(merged, new Set([4001]));

    expect(visible.map((entry) => entry.id)).toEqual([4002]);
  });
});

describe("chat and voice session mapping", () => {
  it("maps text and voice history items to separate session kinds", () => {
    const textItem = item(5001, "typed question", "backend");
    const voiceItem = { ...item(5002, "voice transcript", "backend"), source: "voice" };
    const handsFreeItem = { ...item(5003, "handsfree transcript", "backend"), source: "handsfree" };

    expect(getChatHistoryItemKind(textItem)).toBe("chat");
    expect(getChatHistoryItemKind(voiceItem)).toBe("voice");
    expect(getChatHistoryItemKind(handsFreeItem)).toBe("voice");
    expect(createChatSessionFromItem(textItem).kind).toBe("chat");
    expect(createChatSessionFromItem(voiceItem).kind).toBe("voice");
  });

  it("does not merge mixed chat and voice item IDs into one session", () => {
    const textItem = item(6001, "typed question", "backend");
    const voiceItem = { ...item(6002, "voice transcript", "backend"), source: "voice" };

    const sessions = reconcileChatSessions([textItem, voiceItem], [
      {
        id: "old_mixed_session",
        itemIds: [textItem.id, voiceItem.id],
        createdAt: "2026-05-12T00:00:00Z",
        updatedAt: "2026-05-12T00:00:01Z",
      },
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.kind).sort()).toEqual(["chat", "voice"]);
    expect(sessions.every((session) => session.itemIds.length === 1)).toBe(true);
  });

  it("keeps voice items out of explicit chat sessions", () => {
    const textItem = item(7001, "typed question", "backend");
    const voiceItem = { ...item(7002, "voice transcript", "backend"), source: "voice" };

    const sessions = reconcileChatSessions([textItem, voiceItem], [
      {
        id: "stored_chat",
        itemIds: [textItem.id, voiceItem.id],
        createdAt: "2026-05-12T00:00:00Z",
        updatedAt: "2026-05-12T00:00:01Z",
        kind: "chat",
      },
    ]);

    const chatSession = sessions.find((session) => session.kind === "chat");
    const voiceSession = sessions.find((session) => session.kind === "voice");

    expect(chatSession?.itemIds).toEqual([textItem.id]);
    expect(voiceSession?.itemIds).toEqual([voiceItem.id]);
  });
});
