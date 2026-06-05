/**
 * Synthesized "viseme" scheduler.
 *
 * `expo-av` does not expose live audio metering, so we can't read real mouth
 * shapes off the TTS stream. Instead we fabricate a natural-looking mouth-open
 * curve purely from playback time: layered speech-rate oscillators with a slow
 * phrase envelope. Pure + deterministic so the chat screen can sample it from
 * `setOnPlaybackStatusUpdate` and so it can be unit-tested.
 */

export type VisemeInput = {
  isPlaying: boolean;
  positionMillis: number;
};

const TWO_PI = Math.PI * 2;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Returns the target mouth openness in the range 0…1.
 * - When not playing, the mouth is closed (0).
 * - When playing, it oscillates between near-closed (consonants) and open
 *   (vowels) following a slow phrase envelope.
 */
export function nextMouthOpenness(input: VisemeInput): number {
  if (!input || !input.isPlaying) return 0;

  const millis = Number(input.positionMillis);
  const t = (Number.isFinite(millis) && millis > 0 ? millis : 0) / 1000;

  const syllable = Math.sin(t * TWO_PI * 4.6);
  const sub = Math.sin(t * TWO_PI * 2.2 + 0.7);
  const micro = Math.sin(t * TWO_PI * 9.3 + 1.9);

  // Slow 0.5 Hz envelope so phrases swell and settle.
  const envelope = 0.55 + 0.45 * Math.sin(t * TWO_PI * 0.5 + 0.3);

  const raw = 0.5 * syllable + 0.32 * sub + 0.18 * micro; // ≈ [-1, 1]
  const shaped = 0.42 + 0.46 * raw * envelope;

  return clamp01(shaped);
}
