import type { ChatRequestPayload } from "./swicoTypes";

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
