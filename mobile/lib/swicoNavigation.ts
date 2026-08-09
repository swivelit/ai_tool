import type { Message } from "./swicoTypes";

export function messageIndexForSearch(messages: Message[], messageId: string | null) {
  if (!messageId) return -1;
  return messages.findIndex(message => message.id === messageId);
}

export function fallbackMessageOffset(index: number, rowHeight = 160, viewportPadding = 120) {
  return Math.max(0, index * rowHeight - viewportPadding);
}

