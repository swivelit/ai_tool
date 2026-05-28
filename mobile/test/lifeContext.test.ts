import { afterEach, describe, expect, it, vi } from "vitest";

function mockConstants(extra: Record<string, unknown> = {}) {
  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: {
        extra,
      },
    },
  }));
}

function mockNativeLifeContext() {
  const native = {
    getPermissionState: vi.fn(async () => ({
      activityRecognition: "unavailable",
      usageAccess: "unavailable",
    })),
    requestActivityRecognitionPermission: vi.fn(async () => "unavailable"),
    openUsageAccessSettings: vi.fn(async () => undefined),
    getDailyLifeContext: vi.fn(async () => ({
      date: "2026-05-28",
      timezone: "Asia/Kolkata",
      permissions: {
        activityRecognition: "unavailable",
        usageAccess: "unavailable",
      },
      movement: {
        steps: null,
        estimatedDistanceMeters: null,
        confidence: "unavailable",
        source: "test",
      },
      screen: {
        screenTimeMs: null,
        unlocks: null,
        confidence: "unavailable",
        source: "test",
      },
      apps: [],
      generatedAt: "2026-05-28T00:00:00.000Z",
    })),
  };
  vi.doMock("@/modules/life-context", () => ({
    default: native,
  }));
  return native;
}

describe("life context service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns disabled summary without touching native collection", async () => {
    mockConstants();
    const native = mockNativeLifeContext();

    const { getTodayLifeContextForAi } = await import("../lib/lifeContext");
    const summary = await getTodayLifeContextForAi({
      settings: {
        lifeContextEnabled: false,
        shareLifeContextWithBackend: false,
        shareAppNamesWithAi: false,
      },
    });

    expect(summary.enabled).toBe(false);
    expect(native.getDailyLifeContext).not.toHaveBeenCalled();
  });

  it("returns deterministic E2E mock life context", async () => {
    mockConstants({ EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT: "1" });
    mockNativeLifeContext();

    const { getTodayLifeContextForAi } = await import("../lib/lifeContext");
    const summary = await getTodayLifeContextForAi({
      settings: {
        lifeContextEnabled: true,
        shareLifeContextWithBackend: true,
        shareAppNamesWithAi: true,
      },
      ageGroup: "26_35",
      forBackend: true,
    });

    expect(summary.enabled).toBe(true);
    expect(summary.ageGroup).toBe("26_35");
    expect(summary.raw?.movement.steps).toBe(7420);
    expect(summary.raw?.movement.estimatedDistanceMeters).toBe(5650);
    expect(summary.raw?.screen.screenTimeMs).toBe(12600000);
    expect(summary.movementSummary).toContain("7,420 steps");
    expect(summary.movementSummary).toContain("5.7 km");
    expect(summary.screenSummary).toContain("3.5 hours");
    expect(summary.topAppsSummary).toContain("ChatGPT");
  });

  it("hides app and package names when app-name sharing is disabled", async () => {
    mockConstants({ EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT: "1" });
    mockNativeLifeContext();

    const { getTodayLifeContextForAi } = await import("../lib/lifeContext");
    const summary = await getTodayLifeContextForAi({
      settings: {
        lifeContextEnabled: true,
        shareLifeContextWithBackend: true,
        shareAppNamesWithAi: false,
      },
      forBackend: true,
    });
    const dumped = JSON.stringify(summary);

    expect(dumped).not.toContain("ChatGPT");
    expect(dumped).not.toContain("YouTube");
    expect(dumped).not.toContain("WhatsApp");
    expect(dumped).not.toContain("packageName");
    expect(summary.topAppsSummary).toContain("productivity");
  });
});
