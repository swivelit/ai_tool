export type ReplySource = "text" | "voice" | "handsfree" | string;

export type ReplyLanguage =
  | "english"
  | "tamil"
  | "tanglish"
  | "auto";

export type ReplyPlaybackPolicyInput = {
  source?: ReplySource | null;
  autoSpeakReplies?: boolean | null;
  handsFreeMode?: "off" | "wake" | "command" | string | null;
  replyLanguage?: ReplyLanguage | null;
};

export function normalizeReplyLanguage(
  language?: string | null,
): ReplyLanguage {
  const normalized = String(language || "")
    .trim()
    .toLowerCase();

  if (normalized === "english") {
    return "english";
  }

  if (normalized === "tamil") {
    return "tamil";
  }

  if (normalized === "tanglish") {
    return "tanglish";
  }

  return "auto";
}
export function shouldAutoSpeakReply(input: ReplyPlaybackPolicyInput = {}) {
  const source = String(input.source || "").trim().toLowerCase();
  const handsFreeMode = String(input.handsFreeMode || "off")
    .trim()
    .toLowerCase();

  if (input.autoSpeakReplies !== true) {
    return false;
  }

  return source === "handsfree" && handsFreeMode !== "off";
}
