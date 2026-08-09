export type VoiceReplyState = "idle" | "generating" | "ready" | "playing" | "paused" | "ended" | "error";

export type CachedVoiceReply<T> = { uri: string; sound: T | null; touchedAt: number };

export function needsVoiceSynthesis(state: VoiceReplyState, hasCachedAudio: boolean) {
  return !hasCachedAudio && (state === "idle" || state === "error");
}

/** Small bounded cache so replay never synthesizes again during a session. */
export class VoiceReplyCache<T> {
  private readonly entries = new Map<string, CachedVoiceReply<T>>();

  constructor(private readonly maxEntries = 8) {}

  get(messageId: string) {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;
    entry.touchedAt = Date.now();
    return entry;
  }

  set(messageId: string, entry: Omit<CachedVoiceReply<T>, "touchedAt">) {
    this.entries.set(messageId, { ...entry, touchedAt: Date.now() });
    const evicted: Array<[string, CachedVoiceReply<T>]> = [];
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      evicted.push(oldest);
    }
    return evicted;
  }

  delete(messageId: string) {
    const entry = this.entries.get(messageId);
    this.entries.delete(messageId);
    return entry;
  }

  values() { return [...this.entries.values()]; }
  clear() { this.entries.clear(); }
}
