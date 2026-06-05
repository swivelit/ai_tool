import { describe, expect, it } from "vitest";

import {
  BACKCHANNEL_MAX_GAP_MS,
  BACKCHANNEL_MIN_GAP_MS,
  createBackchannelController,
  decideBackchannel,
  pickCue,
  randomGapMs,
} from "../lib/backchannel";

describe("backchannel scheduling", () => {
  it("picks cue gaps inside the configured range", () => {
    expect(randomGapMs(0)).toBe(BACKCHANNEL_MIN_GAP_MS);
    expect(randomGapMs(1)).toBe(BACKCHANNEL_MAX_GAP_MS);
    expect(randomGapMs(0.5)).toBeGreaterThan(BACKCHANNEL_MIN_GAP_MS);
  });

  it("avoids immediate cue repeats when alternatives exist", () => {
    expect(pickCue("aaha", 0)).not.toBe("aaha");
    expect(pickCue("hmm", 0.99)).not.toBe("hmm");
  });

  it("stops immediately when not listening or when TTS is active", () => {
    expect(decideBackchannel({
      listening: false,
      ttsActive: false,
      nowMs: 1000,
      windowStartedMs: 0,
      gapMs: 3000,
    })).toEqual({ action: "stop", reason: "not-listening" });

    expect(decideBackchannel({
      listening: true,
      ttsActive: true,
      nowMs: 1000,
      windowStartedMs: 0,
      gapMs: 3000,
    })).toEqual({ action: "stop", reason: "tts-active" });
  });

  it("waits until the randomized quiet window elapses", () => {
    expect(decideBackchannel({
      listening: true,
      ttsActive: false,
      nowMs: 1000,
      windowStartedMs: 0,
      gapMs: 3000,
    })).toEqual({ action: "wait", remainingMs: 2000 });
  });

  it("plays a cue after the quiet window elapses", () => {
    const decision = decideBackchannel({
      listening: true,
      ttsActive: false,
      nowMs: 3001,
      windowStartedMs: 0,
      gapMs: 3000,
      lastCue: "aaha",
      random: 0,
    });

    expect(decision).toEqual({ action: "play", cue: "hmm" });
  });

  it("can construct and dispose without loading native audio", async () => {
    const controller = createBackchannelController({
      clips: {},
      now: () => 0,
      random: () => 0,
    });

    controller.setListening(false);
    await controller.dispose();
  });
});
