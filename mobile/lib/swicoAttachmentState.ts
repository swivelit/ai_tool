import type { Attachment } from "./swicoTypes";

export type SwicoAttachmentCapacity = {
  max_files_per_message: number;
  max_total_bytes: number;
  image_max_count?: number;
};

/** Apply one removal intent to both pending selections and historical context. */
export function detachSwicoAttachment(
  attachments: Attachment[],
  attachmentId: string,
  pendingIds: Set<string>,
  detachedIds: Set<string>,
): Attachment[] {
  pendingIds.delete(attachmentId);
  detachedIds.add(attachmentId);
  return attachments.filter(item => item.id !== attachmentId);
}

export function appendWithinSwicoAttachmentCapacity(
  current: Attachment[],
  next: Attachment,
  limits: SwicoAttachmentCapacity,
  now = Date.now(),
): { attachments: Attachment[]; error?: string } {
  const usable = current.filter(item => (
    item.status === "ready" && new Date(item.expires_at).getTime() > now
  ));
  const nextIsImage = String(next.media_type || "").startsWith("image/");
  const bytes = usable.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0);
  const images = usable.filter(item => String(item.media_type || "").startsWith("image/")).length;
  if (usable.length >= limits.max_files_per_message) {
    return { attachments: current, error: `You can attach up to ${limits.max_files_per_message} files.` };
  }
  if (bytes + Number(next.size_bytes || 0) > limits.max_total_bytes) {
    return { attachments: current, error: "The attachment limits for this message have been reached." };
  }
  if (nextIsImage && images >= (limits.image_max_count || 4)) {
    return { attachments: current, error: `You can attach up to ${limits.image_max_count || 4} images.` };
  }
  return { attachments: [...current, next] };
}

export function mergeSwicoHistoryAttachments(
  restored: Attachment[],
  current: Attachment[],
  pendingIds: ReadonlySet<string>,
  limit = 5,
  detachedIds: ReadonlySet<string> = new Set<string>(),
  capacity?: SwicoAttachmentCapacity,
  now = Date.now(),
): Attachment[] {
  const merged = new Map<string, Attachment>();
  for (const item of [...restored, ...current]) {
    if (detachedIds.has(item.id)) continue;
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  const values = [...merged.values()];
  const pending = values.filter(item => pendingIds.has(item.id));
  const historical = values.filter(item => !pendingIds.has(item.id));
  const selected = [...pending];
  let bytes = pending.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0);
  let images = pending.filter(item => String(item.media_type || "").startsWith("image/")).length;
  for (const item of historical) {
    if (selected.length >= limit) break;
    if (capacity && (
      item.status !== "ready"
      || new Date(item.expires_at).getTime() <= now
      || selected.filter(candidate => candidate.status === "ready" && new Date(candidate.expires_at).getTime() > now).length >= capacity.max_files_per_message
      || bytes + Number(item.size_bytes || 0) > capacity.max_total_bytes
      || (String(item.media_type || "").startsWith("image/") && images >= (capacity.image_max_count || 4))
    )) continue;
    selected.push(item);
    bytes += Number(item.size_bytes || 0);
    if (String(item.media_type || "").startsWith("image/")) images += 1;
  }
  return selected;
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
