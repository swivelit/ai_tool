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

  it("produces multiple distinct lip positions during a short spoken reply", () => {
    const values = [0, 80, 160, 240, 320, 400].map((positionMillis) =>
      nextMouthOpenness({ isPlaying: true, positionMillis }),
    );
    const distinct = new Set(values.map((value) => value.toFixed(3)));

    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(distinct.size).toBeGreaterThanOrEqual(3);
  });

  it("handles invalid playback positions", () => {
    expect(nextMouthOpenness({ isPlaying: true, positionMillis: Number.NaN })).toBeGreaterThanOrEqual(0);
  });
});
