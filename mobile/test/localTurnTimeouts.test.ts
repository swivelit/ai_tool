import { describe, expect, it } from "vitest";

import {
  getLocalTurnSoftNoticeMs,
  getLocalTurnTimeoutMs,
} from "../lib/localTurnTimeouts";

describe("local turn timeouts", () => {
  it("gives Lite text enough time for CPU-only native inference", () => {
    const timeout = getLocalTurnTimeoutMs({ source: "text", selectedTier: "lite" });

    expect(timeout).toBeGreaterThanOrEqual(85_000);
    expect(timeout).toBeLessThanOrEqual(95_000);
  });

  it("keeps voice timeouts safe and capped", () => {
    const text = getLocalTurnTimeoutMs({ source: "text", selectedTier: "lite" });
    const voice = getLocalTurnTimeoutMs({ source: "voice", selectedTier: "lite" });

    expect(voice).toBeGreaterThanOrEqual(text);
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
    expect(standard).toBeGreaterThanOrEqual(115_000);
    expect(pro).toBeGreaterThanOrEqual(145_000);
  });

  it("returns a soft notice delay before the hard timeout", () => {
    const notice = getLocalTurnSoftNoticeMs({ source: "text", selectedTier: "lite" });

    expect(notice).toBeGreaterThanOrEqual(15_000);
    expect(notice).toBeLessThanOrEqual(20_000);
    expect(notice).toBeLessThan(getLocalTurnTimeoutMs({ source: "text", selectedTier: "lite" }));
  });
});
