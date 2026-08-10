import type { Attachment, Message } from "./swicoTypes";

export function hasSendableContent(draft: string, attachments: Attachment[], repositoryReady: boolean, repositoryChatEnabled = true) {
  return Boolean(draft.trim() || attachments.some(attachment => attachment.status === "ready") || (repositoryChatEnabled && repositoryReady));
}

export function latestEditableUserId(messages: Message[], generationActive: boolean) {
  if (generationActive) return null;
  return [...messages].reverse().find(message => message.role === "user" && message.status === "complete")?.id ?? null;
}

export function assistantActionsEnabled(message: Message, feedbackEnabled: boolean, voiceEnabled: boolean) {
  return {
    completed: message.role === "assistant" && message.status === "complete",
    feedback: message.role === "assistant" && message.status === "complete" && feedbackEnabled,
    voice: message.role === "assistant" && message.status === "complete" && voiceEnabled && Boolean(message.voice_turn_id),
  };
}

export function retryAvailability(message: Pick<Message, "status" | "retry_at">, now = Date.now()) {
  const retryAt = message.retry_at ? Date.parse(message.retry_at) : NaN;
  const remainingSeconds = Number.isFinite(retryAt) && retryAt > now ? Math.max(1, Math.ceil((retryAt - now) / 1000)) : 0;
  return { eligible: message.status === "retryable" && remainingSeconds === 0, blocked: message.status === "retryable" && remainingSeconds > 0, remainingSeconds };
}
