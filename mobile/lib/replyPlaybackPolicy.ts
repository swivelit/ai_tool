export type ReplySource = "text" | "voice" | "handsfree" | string;

export type ReplyPlaybackPolicyInput = {
  source?: ReplySource | null;
  autoSpeakReplies?: boolean | null;
  handsFreeMode?: "off" | "wake" | "command" | string | null;
};

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
