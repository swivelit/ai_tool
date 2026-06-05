import { describe, expect, it } from "vitest";

import { nextMouthOpenness } from "../lib/visemeScheduler";

describe("viseme scheduler", () => {
  it("closes the mouth when playback is not active", () => {
    expect(nextMouthOpenness({ isPlaying: false, positionMillis: 500 })).toBe(0);
  });

  it("returns deterministic values in the mouth openness range", () => {
    const first = nextMouthOpenness({ isPlaying: true, positionMillis: 250 });
    const again = nextMouthOpenness({ isPlaying: true, positionMillis: 250 });

    expect(first).toBe(again);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(1);
  });

  it("changes mouth shape over playback time", () => {
    expect(nextMouthOpenness({ isPlaying: true, positionMillis: 120 })).not.toBe(
      nextMouthOpenness({ isPlaying: true, positionMillis: 620 }),
    );
  });

  it("handles invalid playback positions", () => {
    expect(nextMouthOpenness({ isPlaying: true, positionMillis: Number.NaN })).toBeGreaterThanOrEqual(0);
  });
});
