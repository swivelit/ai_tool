import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BACKCHANNEL_MAX_GAP_MS,
  BACKCHANNEL_MIN_GAP_MS,
  createBackchannelController,
  decideBackchannel,
  pickCue,
  randomGapMs,
} from "../lib/backchannel";

const audioDir = path.join(__dirname, "..", "assets", "audio", "backchannel");
const clipsSource = fs.readFileSync(path.join(audioDir, "clips.ts"), "utf8");
const chatSource = fs.readFileSync(
  path.join(__dirname, "..", "app", "(chat)", "index.tsx"),
  "utf8",
);

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

  it("ships real bundled WAV clips and exports a cue map", () => {
    for (const fileName of ["aaha.wav", "hmm.wav", "mm-hmm.wav"]) {
      const clip = fs.readFileSync(path.join(audioDir, fileName));
      const dataBytes = clip.readUInt32LE(40);
      const sampleRate = clip.readUInt32LE(24);
      const bytesPerSecond = clip.readUInt32LE(28);
      const durationMs = (dataBytes / bytesPerSecond) * 1000;

      expect(clip.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(clip.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(sampleRate).toBeGreaterThanOrEqual(16000);
      expect(durationMs).toBeGreaterThan(80);
      expect(durationMs).toBeLessThan(320);
    }

    expect(clipsSource).toContain('aaha: require("./aaha.wav")');
    expect(clipsSource).toContain('hmm: require("./hmm.wav")');
    expect(clipsSource).toContain('"mm-hmm": require("./mm-hmm.wav")');
  });

  it("passes bundled clips into the chat screen controller", () => {
    expect(chatSource).toContain('import { BACKCHANNEL_CLIPS } from "@/assets/audio/backchannel/clips"');
    expect(chatSource).toContain("clips: BACKCHANNEL_CLIPS");
    expect(chatSource).toContain("setTtsActive(replyAudioPlaying)");
    expect(chatSource).toContain("setListening(backchannelListeningActive)");
  });
});
