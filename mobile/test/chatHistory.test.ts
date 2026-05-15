import { describe, expect, it, vi } from "vitest";

import {
  classifyChatHistoryItemsForDeletion,
  deduplicateChatItems,
  filterHistoryItemsByHiddenItemIds,
  filterLocalChatHistoryItems,
  generateLocalChatItemId,
  markChatHistoryItemsOrigin,
  mergeChatHistoryItems,
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
    created_at: `2026-05-12T00:00:0${Math.abs(id) % 10}Z`,
    source: "text",
    __origin: origin,
  };
}

// ---------------------------------------------------------------------------
// Existing tests (preserved)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// New: multi-turn chat stability
// ---------------------------------------------------------------------------

describe("multi-turn chat stability", () => {
  it("first query and second query both appear after merge — no replacement", () => {
    const turn1 = item(5001, "first query", "local");
    const turn2 = item(5002, "second query", "local");

    // Simulates: after turn 1 resolves → history has [turn1]
    // After turn 2 resolves → merge preserves both
    const afterTurn1 = mergeChatHistoryItems([], [turn1]);
    const afterTurn2 = mergeChatHistoryItems(afterTurn1, [turn2]);

    expect(afterTurn2).toHaveLength(2);
    expect(afterTurn2.map((i) => i.raw_text)).toContain("first query");
    expect(afterTurn2.map((i) => i.raw_text)).toContain("second query");
  });

  it("failed second turn does not remove the first successful turn", () => {
    const turn1 = item(6001, "what is AI?", "local");
    // turn 2 fails — history is NOT mutated
    const historyAfterTurn1 = mergeChatHistoryItems([], [turn1]);

    // Simulate error path: history stays unchanged (test that merge is idempotent)
    const historyAfterFailedTurn2 = mergeChatHistoryItems(historyAfterTurn1);

    expect(historyAfterFailedTurn2).toHaveLength(1);
    expect(historyAfterFailedTurn2[0].raw_text).toBe("what is AI?");
  });

  it("app reload simulation: stored local + backend items merge without loss", () => {
    const localItem = item(7001, "cached question", "local");
    const backendItem = item(7002, "remote question", "backend");

    // Reload: reads both sources and merges
    const afterReload = mergeChatHistoryItems([localItem], [backendItem]);

    expect(afterReload).toHaveLength(2);
    expect(filterLocalChatHistoryItems(afterReload)).toHaveLength(1);
    expect(afterReload.find((i) => i.__origin === "backend")).toBeTruthy();
  });

  it("history drawer: multiple turns in one session stay correctly ordered (newest first)", () => {
    const t1 = item(8001, "turn 1", "local");
    const t2 = item(8002, "turn 2", "local");
    const t3 = item(8003, "turn 3", "local");

    const merged = mergeChatHistoryItems([t1], [t2], [t3]);

    // mergeChatHistoryItems returns sorted newest → oldest (descending ID)
    expect(merged[0].id).toBe(8003);
    expect(merged[1].id).toBe(8002);
    expect(merged[2].id).toBe(8001);
  });

  it("delete one chat: item removed and not re-added by subsequent merge", () => {
    const keep = item(9001, "keep me", "local");
    const del = item(9002, "delete me", "local");

    const history = mergeChatHistoryItems([keep, del]);
    // Mark 9002 as hidden (deleted)
    const hiddenSet = new Set([9002]);
    const visible = filterHistoryItemsByHiddenItemIds(history, hiddenSet);

    // Simulate re-merge (e.g. after backend sync) — deleted ID still hidden
    const afterReMerge = filterHistoryItemsByHiddenItemIds(
      mergeChatHistoryItems(visible, [del]), // del tries to sneak back in
      hiddenSet,
    );

    expect(afterReMerge.map((i) => i.id)).toEqual([9001]);
  });

  it("delete all local-only items: none reappear after mergeChatHistoryItems", () => {
    const locals = [
      item(10001, "q1", "local"),
      item(10002, "q2", "local"),
      item(10003, "q3", "local"),
    ];
    const backendItem = item(10004, "backend q", "backend");

    const hiddenSet = new Set(locals.map((i) => i.id));
    const merged = mergeChatHistoryItems(locals, [backendItem]);
    const visible = filterHistoryItemsByHiddenItemIds(merged, hiddenSet);

    expect(visible).toHaveLength(1);
    expect(visible[0].__origin).toBe("backend");
  });

  it("10 sequential messages all survive merge (acceptance criterion)", () => {
    let history: ChatHistoryItem[] = [];
    for (let i = 1; i <= 10; i++) {
      const turn = item(20000 + i, `message ${i}`, "local");
      history = mergeChatHistoryItems(history, [turn]);
    }

    expect(history).toHaveLength(10);
    for (let i = 1; i <= 10; i++) {
      expect(history.some((it) => it.raw_text === `message ${i}`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// New: local ID collision guard
// ---------------------------------------------------------------------------

describe("generateLocalChatItemId", () => {
  it("returns unique values across 1000 calls", () => {
    const ids = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateLocalChatItemId());
    }
    expect(ids.size).toBe(1000);
  });

  it("always returns negative numbers (cannot collide with backend positive IDs)", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateLocalChatItemId()).toBeLessThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// New: deduplicateChatItems
// ---------------------------------------------------------------------------

describe("deduplicateChatItems", () => {
  it("removes local placeholder IDs when a backend ID mapping is provided", () => {
    const localPlaceholder = item(-1001, "my query", "local");
    const backendReal = item(5555, "my query", "backend");

    const all = [localPlaceholder, backendReal];
    const deduped = deduplicateChatItems(all, new Map([[-1001, 5555]]));

    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe(5555);
  });

  it("is a no-op when the mapping is empty", () => {
    const items = [item(1, "a", "backend"), item(2, "b", "local")];
    expect(deduplicateChatItems(items, new Map())).toHaveLength(2);
  });
});
