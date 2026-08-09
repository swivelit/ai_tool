import type { Attachment, Message } from "./swicoTypes";

export function hasSendableContent(draft: string, attachments: Attachment[], repositoryReady: boolean) {
  return Boolean(draft.trim() || attachments.some(attachment => attachment.status === "ready") || repositoryReady);
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

