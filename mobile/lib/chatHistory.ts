import { ChatHistoryItem } from "./chatResponse";

export type ChatHistoryOrigin = "backend" | "local";

export type ChatHistoryDeletionGroups = {
  backendItems: ChatHistoryItem[];
  localItems: ChatHistoryItem[];
  backendItemIds: string[];
  localItemIds: string[];
  allItemIds: string[];
};

export const LOCAL_CHAT_ITEMS_STORAGE_PREFIX = "chat_local_items_v1";

function toFiniteItemId(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const itemId = String(value).trim();
  return itemId ? itemId : null;
}

export function localChatItemsStorageKey(userId?: number | string | null) {
  const normalizedUserId = String(userId || "guest").trim() || "guest";
  return `${LOCAL_CHAT_ITEMS_STORAGE_PREFIX}:${normalizedUserId}`;
}

export function uniqueItemIdList(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value).trim())
        .filter(Boolean),
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
  hiddenItemIdSet: Set<string>,
) {
  if (!hiddenItemIdSet.size) return items;

  return items.filter((item) => {
    const itemId = toFiniteItemId(item.id);
    return itemId === null || !hiddenItemIdSet.has(itemId);
  });
}

export function mergeChatHistoryItems(...groups: ChatHistoryItem[][]) {
  const map = new Map<string, ChatHistoryItem>();

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

 return Array.from(map.values());
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

  const backendItemIds = uniqueItemIdList(backendItems.map((item) => item.id));
  const localItemIds = uniqueItemIdList(localItems.map((item) => item.id));

  return {
    backendItems,
    localItems,
    backendItemIds,
    localItemIds,
    allItemIds: uniqueItemIdList([...backendItemIds, ...localItemIds]),
  };
}

