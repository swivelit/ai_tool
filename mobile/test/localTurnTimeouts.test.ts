import { describe, expect, it } from "vitest";

import { getLocalTurnTimeoutMs } from "../lib/localTurnTimeouts";

describe("local turn timeouts", () => {
  it("keeps normal text well below the old 150s timeout", () => {
    const timeout = getLocalTurnTimeoutMs({ source: "text", selectedTier: "lite" });

    expect(timeout).toBeLessThan(60_000);
    expect(timeout).toBeGreaterThanOrEqual(20_000);
  });

  it("keeps voice timeouts longer than text timeouts", () => {
    const text = getLocalTurnTimeoutMs({ source: "text", selectedTier: "lite" });
    const voice = getLocalTurnTimeoutMs({ source: "voice", selectedTier: "lite" });

    expect(voice).toBeGreaterThan(text);
    expect(voice).toBeGreaterThanOrEqual(90_000);
    expect(voice).toBeLessThanOrEqual(150_000);
  });

  it("increases or preserves timeout on constrained devices without exceeding the cap", () => {
    const base = getLocalTurnTimeoutMs({ source: "text", selectedTier: "lite" });
    const constrained = getLocalTurnTimeoutMs({
      source: "text",
      selectedTier: "lite",
      deviceInfo: {
        lowMemory: true,
        lowPowerMode: true,
        lowRamDevice: true,
        batteryLevel: 0.12,
        thermalState: "serious",
        availableMemoryBytes: 900_000_000,
      },
    });

    expect(constrained).toBeGreaterThanOrEqual(base);
    expect(constrained).toBeLessThanOrEqual(150_000);
  });

  it("gives standard and pro tiers longer text timeouts than lite", () => {
    const lite = getLocalTurnTimeoutMs({ source: "text", selectedTier: "lite" });
    const standard = getLocalTurnTimeoutMs({
      source: "text",
      selectedTier: "standard",
    });
    const pro = getLocalTurnTimeoutMs({ source: "text", selectedTier: "pro" });

    expect(standard).toBeGreaterThan(lite);
    expect(pro).toBeGreaterThan(standard);
  });
});
