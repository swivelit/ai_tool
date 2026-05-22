import { ChatHistoryItem } from "./chatResponse";

export type ChatHistoryOrigin = "backend" | "local";
export type ChatSessionKind = "chat" | "voice";

export type ChatSessionRecord = {
  id: string;
  itemIds: number[];
  createdAt: string;
  updatedAt: string;
  title?: string | null;
  kind?: ChatSessionKind;
};

export type ChatHistoryDeletionGroups = {
  backendItems: ChatHistoryItem[];
  localItems: ChatHistoryItem[];
  backendItemIds: number[];
  localItemIds: number[];
  allItemIds: number[];
};

export const LOCAL_CHAT_ITEMS_STORAGE_PREFIX = "chat_local_items_v1";

function toFiniteItemId(value: unknown): number | null {
  const itemId = Number(value);
  return Number.isFinite(itemId) ? itemId : null;
}

export function localChatItemsStorageKey(userId?: number | string | null) {
  const normalizedUserId = String(userId || "guest").trim() || "guest";
  return `${LOCAL_CHAT_ITEMS_STORAGE_PREFIX}:${normalizedUserId}`;
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

export function getChatHistoryItemKind(
  item?: Partial<ChatHistoryItem> | null,
): ChatSessionKind {
  const source = String(item?.source || "").trim().toLowerCase();
  return source === "voice" || source === "handsfree" ? "voice" : "chat";
}

export function sessionTimeValue(value?: string | null) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortSessionsByRecent(a: ChatSessionRecord, b: ChatSessionRecord) {
  return (
    sessionTimeValue(b.updatedAt || b.createdAt) -
    sessionTimeValue(a.updatedAt || a.createdAt)
  );
}

function historyTitleForItem(item: ChatHistoryItem) {
  const title = String(item.title || "").trim();
  if (title) return title;

  const raw = String(item.raw_text || "").trim();
  if (raw) return raw;

  return getChatHistoryItemKind(item) === "voice" ? "Voice" : "Chat";
}

function normalizedSessionKind(value: unknown): ChatSessionKind | undefined {
  return value === "voice" || value === "chat" ? value : undefined;
}

export function normalizeChatSessionRecord(value: unknown): ChatSessionRecord | null {
  if (!value || typeof value !== "object") return null;

  const raw = value as Partial<ChatSessionRecord>;
  const id = String(raw.id || "").trim();
  if (!id) return null;

  const itemIds = uniqueNumberList(Array.isArray(raw.itemIds) ? raw.itemIds : []);
  const createdAt = String(raw.createdAt || raw.updatedAt || new Date().toISOString());
  const updatedAt = String(raw.updatedAt || raw.createdAt || createdAt);
  const kind = normalizedSessionKind(raw.kind);

  return {
    id,
    itemIds,
    createdAt,
    updatedAt,
    title: typeof raw.title === "string" ? raw.title : null,
    ...(kind ? { kind } : {}),
  };
}

export function createChatSessionFromItem(item: ChatHistoryItem): ChatSessionRecord {
  const timestamp = item.created_at || item.datetime || new Date().toISOString();
  const kind = getChatHistoryItemKind(item);
  return {
    id: `${kind}_${Number(item.id) || Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    itemIds: [Number(item.id)],
    createdAt: timestamp,
    updatedAt: timestamp,
    title: historyTitleForItem(item),
    kind,
  };
}

export function reconcileChatSessions(
  items: ChatHistoryItem[],
  sessions: ChatSessionRecord[],
): ChatSessionRecord[] {
  const itemMap = new Map<number, ChatHistoryItem>();
  items.forEach((item) => {
    const itemId = Number(item.id);
    if (Number.isFinite(itemId)) {
      itemMap.set(itemId, item);
    }
  });

  const claimedItemIds = new Set<number>();
  const normalizedSessions: ChatSessionRecord[] = [];

  sessions.forEach((value) => {
    const session = normalizeChatSessionRecord(value);
    if (!session) return;

    let sessionKind = session.kind;
    const itemIds: number[] = [];

    session.itemIds.forEach((itemId) => {
      const item = itemMap.get(itemId);
      if (!item || claimedItemIds.has(itemId)) return;

      const itemKind = getChatHistoryItemKind(item);
      if (!sessionKind) {
        sessionKind = itemKind;
      }
      if (itemKind !== sessionKind) return;

      claimedItemIds.add(itemId);
      itemIds.push(itemId);
    });

    if (!itemIds.length) return;

    const firstItem = itemMap.get(itemIds[0]);
    const lastItem = itemMap.get(itemIds[itemIds.length - 1]);
    normalizedSessions.push({
      ...session,
      kind: sessionKind || "chat",
      itemIds,
      createdAt:
        session.createdAt || firstItem?.created_at || firstItem?.datetime || new Date().toISOString(),
      updatedAt:
        lastItem?.created_at ||
        lastItem?.datetime ||
        session.updatedAt ||
        session.createdAt ||
        new Date().toISOString(),
      title: session.title || (firstItem ? historyTitleForItem(firstItem) : "Chat"),
    });
  });

  const migratedSessions = items
    .filter((item) => {
      const itemId = Number(item.id);
      return Number.isFinite(itemId) && !claimedItemIds.has(itemId);
    })
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((item) => createChatSessionFromItem(item));

  return [...normalizedSessions, ...migratedSessions].sort(sortSessionsByRecent);
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

  return Array.from(map.values()).sort((a, b) => Number(b.id) - Number(a.id));
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
