export type ReplySource = "text" | "voice" | "handsfree" | string;

export type ReplyPlaybackPolicyInput = {
  source?: ReplySource | null;
  autoSpeakReplies?: boolean | null;
  handsFreeMode?: "off" | "wake" | "command" | "conversation" | string | null;
  voiceSurface?: "quick" | "live" | string | null;
  voiceOnlyMode?: boolean | null;
};

export function shouldAutoSpeakReply(input: ReplyPlaybackPolicyInput = {}) {
  const source = String(input.source || "").trim().toLowerCase();
  const handsFreeMode = String(input.handsFreeMode || "off")
    .trim()
    .toLowerCase();
  const voiceSurface = String(input.voiceSurface || "").trim().toLowerCase();

  if (source === "handsfree") {
    return handsFreeMode !== "off";
  }

  if (source === "voice") {
    return voiceSurface === "live";
  }

  return false;
}
