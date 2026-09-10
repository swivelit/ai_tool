import type { Attachment } from "./swicoTypes";

export function mergeSwicoHistoryAttachments(
  restored: Attachment[],
  current: Attachment[],
  pendingIds: ReadonlySet<string>,
  limit = 5,
  detachedIds: ReadonlySet<string> = new Set<string>(),
): Attachment[] {
  const merged = new Map<string, Attachment>();
  for (const item of [...restored, ...current]) {
    if (detachedIds.has(item.id)) continue;
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  const values = [...merged.values()];
  const pending = values.filter(item => pendingIds.has(item.id));
  const historical = values.filter(item => !pendingIds.has(item.id));
  return [...pending, ...historical.slice(0, Math.max(0, limit - pending.length))];
}

export function expiredExplicitAttachments(
  attachments: Attachment[],
  pendingIds: ReadonlySet<string>,
  now = Date.now(),
  explicitlySelected = false,
): Attachment[] {
  return attachments.filter(item => (
    (item.status === "expired" || new Date(item.expires_at).getTime() <= now)
    && (explicitlySelected || pendingIds.has(item.id))
  ));
}
