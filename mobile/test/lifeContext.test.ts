import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetAsyncStorageMock } from "./mocks/async-storage";

function mockConstants(extra: Record<string, unknown> = {}) {
  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: {
        extra,
      },
    },
  }));
}

function mockNativeLifeContext(contextOverride: Record<string, any> = {}) {
  const baseContext = {
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
    ...contextOverride,
  };
  const native = {
    getPermissionState: vi.fn(async () => ({
      activityRecognition: "unavailable",
      usageAccess: "unavailable",
    })),
    requestActivityRecognitionPermission: vi.fn(async () => "unavailable"),
    openUsageAccessSettings: vi.fn(async () => undefined),
    getDailyLifeContext: vi.fn(async () => baseContext),
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
    vi.useRealTimers();
    __resetAsyncStorageMock();
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
    expect(summary.movementSummary).toContain("% of daily goal");
    expect(summary.movementSummary).toContain("5.7 km");
    expect(summary.screenSummary).toContain("3.5 hours");
    expect(summary.screenSummary).toContain("healthy");
    expect(summary.topAppsSummary).toContain("ChatGPT");
    expect(summary.topAppsSummary).toContain("mostly productivity");
    expect(summary.lifeInsightSummary).toContain("7,420 steps");
    expect(summary.lifeInsightSummary).toContain("Top apps:");
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

  it("marks partial-day step counts without presenting them as a full-day total", async () => {
    mockConstants();
    mockNativeLifeContext({
      permissions: { activityRecognition: "granted", usageAccess: "granted" },
      movement: {
        steps: 1200,
        estimatedDistanceMeters: 914,
        confidence: "medium",
        source: "android_step_counter_daily_baseline",
        partialDay: true,
        trackingStartedAtMs: 1779980000000,
      },
      screen: { screenTimeMs: 0, unlocks: null, confidence: "high", source: "test" },
    });

    const { getTodayLifeContextForAi } = await import("../lib/lifeContext");
    const summary = await getTodayLifeContextForAi({
      settings: {
        lifeContextEnabled: true,
        shareLifeContextWithBackend: true,
        shareAppNamesWithAi: false,
      },
      ageGroup: "26_35",
      forBackend: true,
      forceRefresh: true,
    });

    expect(summary.movementSummary).toContain("since tracking started today");
    expect(summary.movementSummary).toContain("partial-day estimate");
    expect(summary.movementSummary).not.toContain("1,200 steps today");
  });

  it("uses normal today wording when step tracking is not partial", async () => {
    mockConstants();
    mockNativeLifeContext({
      permissions: { activityRecognition: "granted", usageAccess: "granted" },
      movement: {
        steps: 8000,
        estimatedDistanceMeters: 6096,
        confidence: "high",
        source: "android_step_counter_daily_baseline",
        partialDay: false,
      },
      screen: { screenTimeMs: 0, unlocks: null, confidence: "high", source: "test" },
    });

    const { getTodayLifeContextForAi } = await import("../lib/lifeContext");
    const summary = await getTodayLifeContextForAi({
      settings: {
        lifeContextEnabled: true,
        shareLifeContextWithBackend: true,
        shareAppNamesWithAi: false,
      },
      ageGroup: "26_35",
      forBackend: true,
      forceRefresh: true,
    });

    expect(summary.movementSummary).toContain("8,000 steps today");
    expect(summary.movementSummary).toContain("% of daily goal");
  });

  it("forceRefresh bypasses the life context cache", async () => {
    mockConstants();
    const native = mockNativeLifeContext({
      permissions: { activityRecognition: "granted", usageAccess: "granted" },
      movement: { steps: 1000, estimatedDistanceMeters: 762, confidence: "high", source: "test" },
      screen: { screenTimeMs: 60000, unlocks: null, confidence: "high", source: "test" },
    });
    const { getTodayLifeContextForAi } = await import("../lib/lifeContext");
    const input = {
      settings: {
        lifeContextEnabled: true,
        shareLifeContextWithBackend: true,
        shareAppNamesWithAi: false,
      },
      forBackend: true,
    };

    await getTodayLifeContextForAi(input);
    await getTodayLifeContextForAi(input);
    await getTodayLifeContextForAi({ ...input, forceRefresh: true });

    expect(native.getDailyLifeContext).toHaveBeenCalledTimes(2);
  });

  it("does not keep unavailable permission results in the normal cache window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
    mockConstants();
    const native = mockNativeLifeContext();
    const { getTodayLifeContextForAi } = await import("../lib/lifeContext");
    const input = {
      settings: {
        lifeContextEnabled: true,
        shareLifeContextWithBackend: true,
        shareAppNamesWithAi: false,
      },
      forBackend: true,
    };

    await getTodayLifeContextForAi(input);
    vi.setSystemTime(new Date("2026-05-28T00:00:11.000Z"));
    await getTodayLifeContextForAi(input);

    expect(native.getDailyLifeContext).toHaveBeenCalledTimes(2);
  });
});
