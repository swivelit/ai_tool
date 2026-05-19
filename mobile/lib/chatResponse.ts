import { Item } from "./types";

export type ChatHistoryItem = Item & {
  created_at?: string | null;
  source?: string | null;
  __origin?: "backend" | "local";
};

export type BackendChatResponse = Partial<ChatHistoryItem> & {
  ok?: boolean;
  kind?: string;
  item?: (Item & { created_at?: string | null; source?: string | null }) | null;
  assistant?: {
    text?: string;
    english?: string;
    tamil?: string;
    theni_tamil?: string;
  } | null;
  meta?: Record<string, any> | null;
};

function inferChatHistoryOrigin(payload: BackendChatResponse): ChatHistoryItem["__origin"] {
  const explicitOrigin = payload.__origin || (payload.item as ChatHistoryItem | null)?.__origin;
  if (explicitOrigin === "backend" || explicitOrigin === "local") {
    return explicitOrigin;
  }

  const metaSource = String(payload.meta?.source || "").trim();
  const kind = String(payload.kind || "").trim();
  if (
    ["local_quick_reply", "local_chat_proxy", "local_voice_proxy"].includes(metaSource) ||
    ["voice_unavailable", "cloud_consent_required"].includes(kind)
  ) {
    return "local";
  }

  return undefined;
}

export function normalizeChatResponse(
  payload: BackendChatResponse,
  fallbackRawText: string
): ChatHistoryItem {
  const origin = inferChatHistoryOrigin(payload);
  const nestedItem = payload?.item;
  const legacyFlatItem =
    !nestedItem &&
    payload &&
    typeof payload === "object" &&
    ("id" in payload || "intent" in payload || "raw_text" in payload || "datetime" in payload)
      ? payload
      : null;
  const item = nestedItem || legacyFlatItem;

  if (item && typeof item === "object") {
    return {
      id: item.id || `local_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      intent: String(item.intent || "assistant"),
      category: String(item.category || "Other"),
      raw_text: String(item.raw_text || fallbackRawText || ""),
      transcript: item.transcript ?? null,
      datetime: item.datetime ?? null,
      title: item.title ?? null,
      details:
        item.details ||
        payload?.assistant?.text ||
        payload?.assistant?.theni_tamil ||
        payload?.assistant?.tamil ||
        payload?.assistant?.english ||
        item.raw_text ||
        fallbackRawText,
      created_at: item.created_at ?? new Date().toISOString(),
      source: item.source ?? "text",
      ...(origin ? { __origin: origin } : {}),
    };
  }

  return {
    id: `local_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    intent: "assistant",
    category: "Other",
    raw_text: fallbackRawText,
    transcript: null,
    datetime: null,
    title: "Assistant",
    details:
      payload?.assistant?.text ||
      payload?.assistant?.theni_tamil ||
      payload?.assistant?.tamil ||
      payload?.assistant?.english ||
      fallbackRawText,
    created_at: new Date().toISOString(),
    source: "text",
    ...(origin ? { __origin: origin } : {}),
  };
}

export function normalizeChatTurnPayload(
  payload: BackendChatResponse | ChatHistoryItem,
  fallbackRawText = ""
): ChatHistoryItem {
  if (payload && typeof payload === "object" && ("item" in payload || "assistant" in payload)) {
    return normalizeChatResponse(payload as BackendChatResponse, fallbackRawText);
  }

  const item = payload as ChatHistoryItem;
  return normalizeChatResponse(
    {
      item,
      assistant: {
        text: item.details || fallbackRawText,
      },
    },
    item.raw_text || fallbackRawText
  );
}
