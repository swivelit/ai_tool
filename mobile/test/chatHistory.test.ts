import { describe, expect, it, vi } from "vitest";

import {
  classifyChatHistoryItemsForDeletion,
  filterHistoryItemsByHiddenItemIds,
  filterLocalChatHistoryItems,
  markChatHistoryItemsOrigin,
  mergeChatHistoryItems,
} from "@/lib/chatHistory";
import { ChatHistoryItem } from "@/lib/chatResponse";

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

