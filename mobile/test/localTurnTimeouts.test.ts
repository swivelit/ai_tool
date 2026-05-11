import { describe, expect, it } from "vitest";

import { getLocalTurnTimeoutMs } from "../lib/localTurnTimeouts";

describe("local turn timeouts", () => {
  it("uses a text default longer than the previous 60s timeout", () => {
    expect(getLocalTurnTimeoutMs({ source: "text" })).toBeGreaterThan(60_000);
  });

  it("keeps voice timeouts greater than or equal to text timeouts", () => {
    const text = getLocalTurnTimeoutMs({ source: "text", selectedTier: "lite" });
    const voice = getLocalTurnTimeoutMs({ source: "voice", selectedTier: "lite" });

    expect(voice).toBeGreaterThanOrEqual(text);
    expect(voice).toBeGreaterThanOrEqual(180_000);
  });

  it("increases or preserves timeout on constrained devices", () => {
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
