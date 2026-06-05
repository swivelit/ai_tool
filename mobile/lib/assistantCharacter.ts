/**
 * Pure decision logic for the animated assistant character.
 *
 * This module has NO React/React Native/reanimated imports on purpose: it holds
 * the "what should the face look like" mapping so it can be unit-tested in node
 * without rendering. `components/AssistantCharacter.tsx` imports these helpers
 * and drives the actual reanimated/gradient layers from the numbers returned
 * here.
 */

export type Emotion =
  | "neutral"
  | "happy"
  | "thinking"
  | "concerned"
  | "excited";

export type CharacterState = "idle" | "listening" | "speaking";

export type CharacterMode = "hero" | "floating";

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export type EmotionShape = {
  /** Vertical scale of the eye ovals (1 = round, <1 = squint, >1 = wide). */
  eyeScaleY: number;
  /** Brow rotation in degrees for the *right* brow (left is mirrored). */
  browTilt: number;
  /** Additive bias to baseline eye openness (−1…1). */
  eyeOpenBias: number;
  /** Mouth corner curve: −1 = full frown, 0 = flat, 1 = full smile. */
  mouthCurve: number;
  /** Resting mouth openness (0…1) used when the character is not speaking. */
  mouthRest: number;
  /** Pupil vertical shift (−1 = look up, 1 = look down). */
  pupilShiftY: number;
};

/** Maps an emotion to the static face shape it should hold. */
export function emotionShape(emotion: Emotion): EmotionShape {
  switch (emotion) {
    case "happy":
      return {
        eyeScaleY: 0.9,
        browTilt: 7,
        eyeOpenBias: 0.04,
        mouthCurve: 0.8,
        mouthRest: 0.12,
        pupilShiftY: 0,
      };
    case "excited":
      return {
        eyeScaleY: 1.14,
        browTilt: 13,
        eyeOpenBias: 0.12,
        mouthCurve: 1,
        mouthRest: 0.24,
        pupilShiftY: -0.12,
      };
    case "thinking":
      return {
        eyeScaleY: 0.84,
        browTilt: -9,
        eyeOpenBias: -0.05,
        mouthCurve: -0.1,
        mouthRest: 0.05,
        pupilShiftY: -0.55,
      };
    case "concerned":
      return {
        eyeScaleY: 1.06,
        browTilt: -17,
        eyeOpenBias: 0.06,
        mouthCurve: -0.7,
        mouthRest: 0.07,
        pupilShiftY: 0.18,
      };
    case "neutral":
    default:
      return {
        eyeScaleY: 1,
        browTilt: 0,
        eyeOpenBias: 0,
        mouthCurve: 0.16,
        mouthRest: 0.08,
        pupilShiftY: 0,
      };
  }
}

/** How strongly the body halo glows per interaction state. */
export const STATE_GLOW: Record<CharacterState, number> = {
  idle: 0.18,
  listening: 0.62,
  speaking: 0.46,
};

/**
 * Final mouth openness (0…1).
 *
 * When speaking, the synthesized voice `amplitude` (and optional internal
 * oscillator `speakingWave`) drives the lips apart. Otherwise the mouth sits at
 * the emotion's resting openness so it still "breathes".
 */
export function resolveMouthOpenness(input: {
  state: CharacterState;
  emotion: Emotion;
  amplitude: number;
  speakingWave?: number;
}): number {
  const shape = emotionShape(input.emotion);
  if (input.state === "speaking") {
    const amp = clamp01(input.amplitude);
    const wave =
      input.speakingWave == null ? 1 : clamp01(input.speakingWave);
    return clamp01(Math.max(shape.mouthRest, 0.12 + 0.88 * amp * wave));
  }
  return clamp01(shape.mouthRest);
}

/**
 * Eye openness (0 = lids shut, 1 = fully open) combining the blink animation
 * value with the emotion's openness bias.
 */
export function resolveEyeOpenness(input: {
  emotion: Emotion;
  blink: number;
}): number {
  const shape = emotionShape(input.emotion);
  const base = clamp01(1 + shape.eyeOpenBias);
  return clamp01(input.blink * base);
}

export type CharacterVisuals = {
  mouthOpenness: number;
  /** Combined vertical eye scale after blink + emotion. */
  eyeScaleY: number;
  browTilt: number;
  mouthCurve: number;
  pupilShiftY: number;
  glow: number;
  listening: boolean;
  speaking: boolean;
};

/**
 * The single entry point the component (and tests) use to turn props into the
 * numbers that drive every layer of the face.
 */
export function resolveCharacterVisuals(input: {
  state: CharacterState;
  emotion: Emotion;
  amplitude: number;
  blink?: number;
  speakingWave?: number;
}): CharacterVisuals {
  const shape = emotionShape(input.emotion);
  const blink = input.blink == null ? 1 : clamp01(input.blink);
  const eyeOpen = resolveEyeOpenness({ emotion: input.emotion, blink });
  return {
    mouthOpenness: resolveMouthOpenness(input),
    eyeScaleY: shape.eyeScaleY * eyeOpen,
    browTilt: shape.browTilt,
    mouthCurve: shape.mouthCurve,
    pupilShiftY: shape.pupilShiftY,
    glow: STATE_GLOW[input.state] ?? STATE_GLOW.idle,
    listening: input.state === "listening",
    speaking: input.state === "speaking",
  };
}
