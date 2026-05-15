import { ChatHistoryItem } from "./chatResponse";

export type ChatHistoryOrigin = "backend" | "local";

export type ChatHistoryDeletionGroups = {
  backendItems: ChatHistoryItem[];
  localItems: ChatHistoryItem[];
  backendItemIds: number[];
  localItemIds: number[];
  allItemIds: number[];
};

export const LOCAL_CHAT_ITEMS_STORAGE_PREFIX = "chat_local_items_v1";
export const ACTIVE_SESSION_STORAGE_PREFIX = "active_chat_session_v1";

// ---------------------------------------------------------------------------
// Local-only message ID generation
// ---------------------------------------------------------------------------
// Local IDs are *negative* numbers with a per-session random base so they
// can never collide with the positive integer IDs returned by the backend.
// The counter starts at -1 and decrements by 1 for each new ID, offset by a
// random 20-bit base so two concurrent app launches produce disjoint ranges.
// ---------------------------------------------------------------------------
const LOCAL_ID_SESSION_OFFSET = -(Math.floor(Math.random() * 0xf_ffff) * 1000);
let localIdCounter = 0;

export function generateLocalChatItemId(): number {
  localIdCounter -= 1;
  return LOCAL_ID_SESSION_OFFSET + localIdCounter;
}

export function isLocalOnlyItemId(id: number): boolean {
  return id < 0;
}

function toFiniteItemId(value: unknown): number | null {
  const itemId = Number(value);
  return Number.isFinite(itemId) ? itemId : null;
}

export function localChatItemsStorageKey(userId?: number | string | null) {
  const normalizedUserId = String(userId || "guest").trim() || "guest";
  return `${LOCAL_CHAT_ITEMS_STORAGE_PREFIX}:${normalizedUserId}`;
}

export function activeSessionStorageKey(userId?: number | string | null) {
  const normalizedUserId = String(userId || "guest").trim() || "guest";
  return `${ACTIVE_SESSION_STORAGE_PREFIX}:${normalizedUserId}`;
}

export function uniqueNumberList(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value)),
    ),
  );
}

export function markChatHistoryItemsOrigin(
  items: ChatHistoryItem[],
  origin: ChatHistoryOrigin,
) {
  return items.map((item) => ({ ...item, __origin: origin }));
}

export function isLocalChatHistoryItem(item?: Partial<ChatHistoryItem> | null) {
  return item?.__origin === "local";
}

export function isBackendChatHistoryItem(item?: Partial<ChatHistoryItem> | null) {
  return item?.__origin !== "local";
}

export function filterLocalChatHistoryItems(items: ChatHistoryItem[]) {
  return items.filter((item) => isLocalChatHistoryItem(item));
}

export function filterHistoryItemsByHiddenItemIds(
  items: ChatHistoryItem[],
  hiddenItemIdSet: Set<number>,
) {
  if (!hiddenItemIdSet.size) return items;

  return items.filter((item) => {
    const itemId = toFiniteItemId(item.id);
    return itemId === null || !hiddenItemIdSet.has(itemId);
  });
}

export function mergeChatHistoryItems(...groups: ChatHistoryItem[][]) {
  const map = new Map<number, ChatHistoryItem>();

  groups.flat().forEach((item) => {
    const itemId = toFiniteItemId(item?.id);
    if (itemId === null) return;

    const existing = map.get(itemId);
    const origin = item.__origin || existing?.__origin;
    map.set(itemId, {
      ...(existing || {}),
      ...item,
      id: itemId,
      ...(origin ? { __origin: origin } : {}),
    } as ChatHistoryItem);
  });

  return Array.from(map.values()).sort((a, b) => {
    // Sort local-only IDs (negative) before backend IDs (positive) by their
    // absolute value so that the timeline remains chronologically ordered.
    // Within local IDs, a more-negative number is older (lower counter).
    // Backend IDs are sorted descending (newest first) by their positive value.
    const aId = Number(a.id);
    const bId = Number(b.id);
    return bId - aId;
  });
}

/**
 * When the backend assigns a real ID to an item that was previously tracked
 * with a local placeholder ID, this function replaces the placeholder entry
 * in `items` with the canonical backend item (by matching on `raw_text` +
 * `created_at` proximity) and removes the stale local ID.
 *
 * This is a best-effort deduplication — if the backend item cannot be matched,
 * both entries are preserved (the local one will be hidden by hiddenItemIds).
 */
export function deduplicateChatItems(
  items: ChatHistoryItem[],
  localIdToBackendId: Map<number, number>,
): ChatHistoryItem[] {
  if (!localIdToBackendId.size) return items;

  const removedLocalIds = new Set(localIdToBackendId.keys());

  return items.filter((item) => {
    const itemId = toFiniteItemId(item.id);
    return itemId === null || !removedLocalIds.has(itemId);
  });
}

export function classifyChatHistoryItemsForDeletion(
  items: ChatHistoryItem[],
): ChatHistoryDeletionGroups {
  const backendItems: ChatHistoryItem[] = [];
  const localItems: ChatHistoryItem[] = [];

  items.forEach((item) => {
    if (isLocalChatHistoryItem(item)) {
      localItems.push(item);
    } else {
      backendItems.push(item);
    }
  });

  const backendItemIds = uniqueNumberList(backendItems.map((item) => item.id));
  const localItemIds = uniqueNumberList(localItems.map((item) => item.id));

  return {
    backendItems,
    localItems,
    backendItemIds,
    localItemIds,
    allItemIds: uniqueNumberList([...backendItemIds, ...localItemIds]),
  };
}
