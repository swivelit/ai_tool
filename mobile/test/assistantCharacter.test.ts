import { describe, expect, it } from "vitest";

import {
  clamp01,
  emotionShape,
  resolveCharacterVisuals,
  resolveEyeOpenness,
  resolveMouthOpenness,
  STATE_GLOW,
} from "../lib/assistantCharacter";

describe("assistant character visuals", () => {
  it("clamps animation inputs into the supported range", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });

  it("maps each emotion to a distinct face shape", () => {
    expect(emotionShape("happy").mouthCurve).toBeGreaterThan(0);
    expect(emotionShape("excited").eyeOpenBias).toBeGreaterThan(0);
    expect(emotionShape("thinking").pupilShiftY).toBeLessThan(0);
    expect(emotionShape("concerned").mouthCurve).toBeLessThan(0);
    expect(emotionShape("neutral").mouthRest).toBeGreaterThan(0);
  });

  it("opens the mouth only from speech amplitude while speaking", () => {
    expect(resolveMouthOpenness({
      state: "idle",
      emotion: "neutral",
      amplitude: 1,
    })).toBe(emotionShape("neutral").mouthRest);

    expect(resolveMouthOpenness({
      state: "speaking",
      emotion: "neutral",
      amplitude: 0.8,
      speakingWave: 1,
    })).toBeGreaterThan(0.6);
  });

  it("combines blink and emotion into eye openness", () => {
    expect(resolveEyeOpenness({ emotion: "neutral", blink: 0 })).toBe(0);
    expect(resolveEyeOpenness({ emotion: "excited", blink: 1 })).toBe(1);
    expect(resolveEyeOpenness({ emotion: "thinking", blink: 1 })).toBeLessThan(1);
  });

  it("resolves render-ready visual flags", () => {
    const visuals = resolveCharacterVisuals({
      state: "listening",
      emotion: "concerned",
      amplitude: 0.2,
      blink: 0.5,
    });

    expect(visuals.listening).toBe(true);
    expect(visuals.speaking).toBe(false);
    expect(visuals.glow).toBe(STATE_GLOW.listening);
    expect(visuals.mouthCurve).toBeLessThan(0);
    expect(visuals.eyeScaleY).toBeGreaterThan(0);
  });
});
