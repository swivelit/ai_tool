export type ReplySource = "text" | "voice" | "handsfree" | string;

export type ReplyLanguage =
  | "english"
  | "tamil"
  | "tanglish"
  | "auto";
let lastPlayedReplyId: string | null = null;
export type ReplyPlaybackPolicyInput = {
  source?: ReplySource | null;
  autoSpeakReplies?: boolean | null;
  handsFreeMode?: "off" | "wake" | "command" | string | null;
  replyLanguage?: ReplyLanguage | null;
  replyId?: string | null;
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
export function shouldAutoSpeakReply(
  input: ReplyPlaybackPolicyInput = {},
) {
  const source = String(input.source || "")
    .trim()
    .toLowerCase();

  const handsFreeMode = String(input.handsFreeMode || "off")
    .trim()
    .toLowerCase();
  const replyId = String(input.replyId || "").trim();

  if (replyId && lastPlayedReplyId === replyId) {
    return false;
  }
  // Hands-free assistant should always auto-speak
  if (source === "handsfree" && handsFreeMode !== "off") {

  if (replyId) {
    lastPlayedReplyId = replyId;
  }

  return true;
  }

  // Voice interactions may auto-speak if enabled
  if (source === "voice") {

  if (input.autoSpeakReplies === true) {

    if (replyId) {
      lastPlayedReplyId = replyId;
    }

    return true;
  }

  return false;
}

  // Normal typed text chat should never auto-play
  return false;
}
