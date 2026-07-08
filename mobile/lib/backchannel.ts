/**
 * Listening backchannel cues.
 *
 * While the user is actively speaking (listening === true) the assistant emits
 * short, low-volume acknowledgement sounds ("aaha", "hmm", "mm-hmm") on a
 * randomized 3–7s cadence — the verbal nods a human listener makes. They stop
 * immediately when listening ends or the assistant starts talking (TTS).
 *
 * The *scheduling logic* (which cue, when to play, when to stop) lives in the
 * pure `decideBackchannel` function below so it can be unit-tested in node. The
 * `createBackchannelController` factory wires that decision to `expo-av`. To
 * keep the pure function importable without pulling native modules into the
 * test runtime, `expo-av` is required lazily (only when a cue actually plays in
 * the app). The bundled defaults are tiny synthetic WAV data URIs as a fallback;
 * the app passes bundled WAV clips through `createBackchannelController`.
 */

export type BackchannelCue = "aaha" | "hmm" | "mm-hmm";

export const BACKCHANNEL_CUES: BackchannelCue[] = ["aaha", "hmm", "mm-hmm"];

export const BACKCHANNEL_MIN_GAP_MS = 3000;
export const BACKCHANNEL_MAX_GAP_MS = 7000;

export type BackchannelInput = {
  /** User is actively speaking and we should be nodding along. */
  listening: boolean;
  /** Assistant TTS is playing — never talk over ourselves. */
  ttsActive: boolean;
  /** Current clock reading (ms). */
  nowMs: number;
  /** When the current quiet window started (listening start / last cue). */
  windowStartedMs: number | null;
  /** Randomized gap chosen for this window (ms). */
  gapMs: number;
  /** The cue we played last, to avoid immediate repeats. */
  lastCue?: BackchannelCue | null;
  /** Random 0..1 used to pick the next cue (injected for determinism). */
  random?: number;
};

export type BackchannelDecision =
  | { action: "stop"; reason: "not-listening" | "tts-active" }
  | { action: "idle"; reason: "no-window" }
  | { action: "wait"; remainingMs: number }
  | { action: "play"; cue: BackchannelCue };

/** Picks the next cue, avoiding an immediate repeat of `lastCue`. */
export function pickCue(
  lastCue: BackchannelCue | null | undefined,
  random: number,
): BackchannelCue {
  const pool = BACKCHANNEL_CUES.filter((cue) => cue !== lastCue);
  const choices = pool.length > 0 ? pool : BACKCHANNEL_CUES;
  const r = Number.isFinite(random) ? Math.min(0.999999, Math.max(0, random)) : 0;
  const index = Math.floor(r * choices.length) % choices.length;
  return choices[index];
}

/** Converts a 0..1 random into a gap in [minMs, maxMs]. */
export function randomGapMs(
  random: number,
  minMs: number = BACKCHANNEL_MIN_GAP_MS,
  maxMs: number = BACKCHANNEL_MAX_GAP_MS,
): number {
  const r = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  return Math.round(minMs + r * (maxMs - minMs));
}

/**
 * Pure scheduler: given the current state, decide whether to stop, keep
 * waiting, or play a cue right now.
 */
export function decideBackchannel(input: BackchannelInput): BackchannelDecision {
  if (input.ttsActive) return { action: "stop", reason: "tts-active" };
  if (!input.listening) return { action: "stop", reason: "not-listening" };
  if (input.windowStartedMs == null) return { action: "idle", reason: "no-window" };

  const elapsed = input.nowMs - input.windowStartedMs;
  const gap = input.gapMs > 0 ? input.gapMs : BACKCHANNEL_MIN_GAP_MS;
  if (elapsed < gap) {
    return { action: "wait", remainingMs: Math.max(0, gap - elapsed) };
  }
  return { action: "play", cue: pickCue(input.lastCue, input.random ?? 0) };
}

// ---------------------------------------------------------------------------
// Controller (impure) — lazily bound to expo-av so the pure logic above stays
// importable in the node test runtime.
// ---------------------------------------------------------------------------

export type ClipSource = number | { uri: string };
export type ClipSources = Record<BackchannelCue, ClipSource>;
type LoadedSound = import("expo-av").Audio.Sound;

export type BackchannelControllerOptions = {
  /** Override the cue -> audio asset map (defaults to synthetic fallbacks). */
  clips?: Partial<ClipSources>;
  minGapMs?: number;
  maxGapMs?: number;
  /** Playback volume 0..1 (cues should be subtle). */
  volume?: number;
  random?: () => number;
  now?: () => number;
};

export type BackchannelController = {
  setListening(listening: boolean): void;
  setTtsActive(active: boolean): void;
  /** Re-arm the timer if we should be running. */
  start(): void;
  /** Halt cues and unload any playing sound. */
  stop(): Promise<void>;
  dispose(): Promise<void>;
};

const PLACEHOLDER_WAV_BASE64 =
  "UklGRiQFAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAFAAAAAAYAGwA8AGkAnwDdAB8BYwGmAeUBHAJJAmgCdwJ0Al0CMgLxAZoBLwGxACEAhP/b/ir+dv3D/BX8cvvf+l/6+Pms+YH5ePmT+dX5PfrL+n37UvxF/VT+ef+tAO0BMANwBKYFyQbUB78IhAkeCoYKugq3CnoKAgpRCWkISwf+BYUE6QIxAWX/jv22++f5KviK9hD1xvOz8t7xT/EJ8Q/xZfEJ8vvyN/S59Xr3cvmY++L9RACzAiMFhQfNCe8L3g2PD/kQERLREjMTMhPOEgUS2xBUD3UNRwvUCCcGTQNVAE/9R/pP93f0zvFj70TtfOsX6k7p+ega6bDpt+os7AXuO/DB8ov1iviv++v+KwJgBXsIagseDosQoxJcFK0Vjxb+FvcWfBaNFTAUbBJKENUNGQskCAYFzgGO/lT7M/g59Xby+O/M7f3rleqZ6RHp/ehf6TTqeesn7TXvmfFG9C/3Rvp5/bkA9gMeByIK8wyBD8ARpBMkFTkW2xYJF8EWBRbYFEETSBH2DlgMewltBj8DAADB/JP5hfao8wrxuO6/7Cjr++k/6ffoJenH6dzqXOxA7n/wDfPe9eL4CvxH/4cCugXRCLoLZw7LENkShxTMFaEWAxfvFmcWaxUDFDQSCBCKDccKzQesBHIBMv76+tz35/Qr8rbvlO3Q63PqhOkJ6QLpcelT6qTrXe117+LxlvSF96D61f0VAVEEdgd1Cj8NxQ/7EdQTSRVQFuYWBxeyFukVsBQOEwoRrw4JDCYJFAbjAqT/Zvw6+TH2WvPE8HzujewB6+HpMen26DHp4ekB643sfO7E8FrzMfY6+Wb8pP/jAhQGJgkJDK8OChEOE7AU6RWyFgcX5hZQFkkV1BP7EcUPPw11CnYHUQQVAdX9oPqF95b04vF1713tpOtT6nHpAukJ6YTpc+rQ65Tttu8r8uf03Pf6+jL+cgGsBM0HxwqKDQgQNBIDFGsVZxbvFgMXoRbMFYcU2RLLEGcOugvRCLoFhwJH/wr84vje9Q3zf/BA7lzs3OrH6SXp9+g/6fvpKOu/7LjuCvGo84X2k/nB/AAAPwNtBnsJWAz2DkgRQRPYFAUWwRYJF9sWORYkFaQTwBGBD/MMIgoeB/YDuQB5/Ub6L/dG9JnxNe8n7XnrNOpf6f3oEemZ6ZXq/evM7fjvdvI59TP4VPuO/s4BBgUkCBkL1Q1KEGwSMBSNFXwW9xb+Fo8WrRVcFKMSixAeDmoLewhgBSsC6/6v+4r4i/XB8jvwBe4s7LfqsOka6fnoTukX6nHrL+1I76/xV/Qy9zD6Qv1XAGADTwYSCZ8L5w3gD4ERxBKiExkUKBTQExUT+hGIEMgOwgyDChcIiwXtAkoAsf0t+8z4mfaf9OfyefFb8JHvH+8F70Lv0++08N/xTvP29ND20Pjr+hb9R/9vAYcDgwVZBwAJcQqmC5kMRg2tDcsNow01DYYMmwt6CikJsQcaBm0EswL1AD7/lP0B/Iv6O/kW+CH3X/bU9YD1ZfWA9dH1VPYF9+D33fj4+Sr7bPy2/QL/RwCCAasCvAOxBIYFNgbABiIHXAdtB1cHHAe+BkEGqAX3BDUEZQOMAq8B1AAAADb/ev7P/Tn9u/xU/Aj81fu8+7z71PsA/ED8kfzv/Ff9xv05/qz+Hf+I/+z/RACSANMABgErAUIBSwFIATkBIQEBAdwAswCJAGAAOgAZAA==";

function placeholderClipSource(): ClipSource {
  return { uri: `data:audio/wav;base64,${PLACEHOLDER_WAV_BASE64}` };
}

function defaultClipSources(): ClipSources {
  // These are synthetic placeholders. The app passes bundled `require(...)`
  // sources; the data URIs remain as a safe fallback for tests and experiments.
  return {
    aaha: placeholderClipSource(),
    hmm: placeholderClipSource(),
    "mm-hmm": placeholderClipSource(),
  };
}

export function createBackchannelController(
  options: BackchannelControllerOptions = {},
): BackchannelController {
  const minGapMs = options.minGapMs ?? BACKCHANNEL_MIN_GAP_MS;
  const maxGapMs = options.maxGapMs ?? BACKCHANNEL_MAX_GAP_MS;
  const volume = options.volume ?? 0.65;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  let listening = false;
  let ttsActive = false;
  let windowStartedMs: number | null = null;
  let currentGapMs = randomGapMs(random(), minGapMs, maxGapMs);
  let lastCue: BackchannelCue | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: LoadedSound | null = null;
  let resolvedClips: Partial<ClipSources> | null = null;

  function getClips(): Partial<ClipSources> {
    if (resolvedClips) return resolvedClips;
    let defaults: Partial<ClipSources> = {};
    try {
      defaults = defaultClipSources();
    } catch {
      defaults = {};
    }
    resolvedClips = { ...defaults, ...(options.clips ?? {}) };
    return resolvedClips;
  }

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleIn(ms: number) {
    clearTimer();
    timer = setTimeout(() => {
      void tick();
    }, Math.max(50, ms));
  }

  async function unload(sound: LoadedSound | null) {
    if (!sound) return;
    try {
      await sound.unloadAsync();
    } catch {
      // ignore
    }
  }

  async function stopPlayback() {
    clearTimer();
    const sound = current;
    current = null;
    await unload(sound);
  }

  async function playCue(cue: BackchannelCue) {
    const source = getClips()[cue];
    if (source == null) return;
    try {
      const { Audio } = require("expo-av") as typeof import("expo-av");
      await unload(current);
      current = null;
      const { sound } = await Audio.Sound.createAsync(source as never, {
        shouldPlay: true,
        volume,
      });
      // A late stop (listening ended / TTS started) may have raced us.
      if (!listening || ttsActive) {
        await unload(sound);
        return;
      }
      current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded || status.didJustFinish) {
          if (current === sound) current = null;
          void unload(sound);
        }
      });
    } catch {
      // Placeholder/invalid clip or audio focus error — skip this cue silently.
    }
  }

  async function tick() {
    const decision = decideBackchannel({
      listening,
      ttsActive,
      nowMs: now(),
      windowStartedMs,
      gapMs: currentGapMs,
      lastCue,
      random: random(),
    });

    if (decision.action === "stop" || decision.action === "idle") {
      await stopPlayback();
      return;
    }
    if (decision.action === "wait") {
      scheduleIn(decision.remainingMs);
      return;
    }

    lastCue = decision.cue;
    await playCue(decision.cue);
    // Open a fresh quiet window before the next nod.
    windowStartedMs = now();
    currentGapMs = randomGapMs(random(), minGapMs, maxGapMs);
    if (listening && !ttsActive) scheduleIn(currentGapMs);
  }

  function arm() {
    if (!listening || ttsActive) return;
    windowStartedMs = now();
    currentGapMs = randomGapMs(random(), minGapMs, maxGapMs);
    scheduleIn(currentGapMs);
  }

  return {
    setListening(next: boolean) {
      if (next === listening) return;
      listening = next;
      if (next) arm();
      else void stopPlayback();
    },
    setTtsActive(active: boolean) {
      if (active === ttsActive) return;
      ttsActive = active;
      if (active) void stopPlayback();
      else if (listening) arm();
    },
    start() {
      arm();
    },
    async stop() {
      listening = false;
      await stopPlayback();
    },
    async dispose() {
      listening = false;
      ttsActive = false;
      await stopPlayback();
    },
  };
}
