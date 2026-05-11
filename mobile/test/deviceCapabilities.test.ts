import { afterEach, describe, expect, it, vi } from "vitest";

const GIB = 1024 * 1024 * 1024;

describe("deviceCapabilities", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function importCapabilities(freeDiskBytes = 32 * GIB) {
    vi.doMock("expo-file-system/legacy", () => ({
      getFreeDiskStorageAsync: vi.fn(async () => freeDiskBytes),
    }));
    return import("../lib/deviceCapabilities");
  }

  function nativeBridge(snapshot: Record<string, any>) {
    return {
      initialize: vi.fn(),
      completeChat: vi.fn(),
      embedTexts: vi.fn(),
      getDeviceCapabilities: vi.fn(async () => snapshot),
    };
  }

  it("uses native capabilities and infers the preferred tier", async () => {
    const bridge = nativeBridge({
      totalMemoryBytes: 16 * GIB,
      availableMemoryBytes: 8 * GIB,
      lowMemory: false,
      lowRamDevice: false,
      lowPowerMode: false,
      batteryLevel: 0.8,
      thermalState: "nominal",
      cpuCoreCount: 8,
      supportedAbis: ["arm64-v8a"],
    });
    vi.stubGlobal("__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__", bridge);

    const { getCachedDeviceCapabilities } = await importCapabilities(32 * GIB);
    const snapshot = await getCachedDeviceCapabilities({ forceRefresh: true });

    expect(bridge.getDeviceCapabilities).toHaveBeenCalledTimes(1);
    expect(snapshot.freeStorageBytes).toBe(32 * GIB);
    expect(snapshot.cpuCoreCount).toBe(8);
    expect(snapshot.supportedAbis).toEqual(["arm64-v8a"]);
    expect(snapshot.preferredTier).toBe("pro");
  });

  it("forces Lite for constrained native capability snapshots", async () => {
    vi.stubGlobal(
      "__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__",
      nativeBridge({
        totalMemoryBytes: 24 * GIB,
        freeStorageBytes: 32 * GIB,
        lowPowerMode: true,
        thermalState: "nominal",
        batteryLevel: 0.8,
      }),
    );

    const { getCachedDeviceCapabilities } = await importCapabilities(32 * GIB);
    const snapshot = await getCachedDeviceCapabilities({ forceRefresh: true });

    expect(snapshot.preferredTier).toBe("lite");
  });

  it("falls back to Lite when native capability is unavailable or unknown", async () => {
    const { getCachedDeviceCapabilities } = await importCapabilities(32 * GIB);
    const snapshot = await getCachedDeviceCapabilities({ forceRefresh: true });

    expect(snapshot.totalMemoryBytes ?? null).toBeNull();
    expect(snapshot.freeStorageBytes).toBe(32 * GIB);
    expect(snapshot.preferredTier).toBe("lite");
  });
});
