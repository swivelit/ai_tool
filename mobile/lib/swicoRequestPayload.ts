import type { ChatRequestPayload } from "./swicoTypes";

export type SwicoMutationOptions = {
  continueId?: string;
  editId?: string;
  regenerateId?: string;
};

/** Select exactly one server mutation target for a newly constructed operation. */
export function normalizeSwicoMutationOptions(
  options: SwicoMutationOptions,
  activeEditTarget?: string | null,
): SwicoMutationOptions {
  if (options.regenerateId) return { regenerateId: options.regenerateId };
  if (options.continueId) return { continueId: options.continueId };
  if (options.editId || activeEditTarget) return { editId: options.editId || activeEditTarget! };
  return {};
}

type RegenerationSource = {
  content: string;
  attachments?: Array<{ id: string }>;
};

/** Build a new server operation without carrying incompatible edit/continue targets. */
export function buildRegeneratePayload(
  prior: ChatRequestPayload | undefined,
  original: RegenerationSource,
  regenerateMessageId: string,
  requestId: string,
): ChatRequestPayload {
  const {
    edit_message_id: _edit,
    continue_message_id: _continue,
    regenerate_message_id: _regenerate,
    request_id: _request,
    message: _message,
    attachment_ids: _attachments,
    ...stableTargeting
  } = prior || {};
  return {
    ...stableTargeting,
    request_id: requestId,
    message: original.content,
    attachment_ids: original.attachments?.map(item => item.id) || prior?.attachment_ids || [],
    regenerate_message_id: regenerateMessageId,
  } as ChatRequestPayload;
}
