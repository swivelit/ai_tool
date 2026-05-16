import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorage = new Map<string, string>();
const secureStorage = new Map<string, string>();

function writeStoredSettings(key: string, value: Record<string, unknown>) {
  const serialized = JSON.stringify(value);
  asyncStorage.set(key, serialized);
  secureStorage.set(key, serialized);
}

function readStoredSettings(key: string) {
  return JSON.parse(secureStorage.get(key) ?? asyncStorage.get(key) ?? "{}");
}

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStorage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStorage.delete(key);
    }),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => secureStorage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStorage.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStorage.delete(key);
  }),
}));

describe("cloud fallback settings", () => {
  beforeEach(() => {
    asyncStorage.clear();
    secureStorage.clear();
  });

  it("defaults cloud fallback consent to true", async () => {
    const { CLOUD_FALLBACK_POLICY_VERSION, getSettings } = await import("../lib/storage");
    const { loadCloudFallbackConsent } = await import("../lib/localAssistantSettings");
    const settings = await getSettings();

    expect(settings.allowCloudFallback).toBe(true);
    expect(settings.cloudFallbackPolicyVersion).toBe(CLOUD_FALLBACK_POLICY_VERSION);
    await expect(loadCloudFallbackConsent()).resolves.toBe(true);
  });

  it("migrates legacy stored false without a user-choice marker to true", async () => {
    const { KEYS, getSettings } = await import("../lib/storage");
    const { loadCloudFallbackConsent } = await import("../lib/localAssistantSettings");

    writeStoredSettings(KEYS.settings, { allowCloudFallback: false });

    await expect(getSettings()).resolves.toMatchObject({
      allowCloudFallback: true,
    });
    await expect(loadCloudFallbackConsent()).resolves.toBe(true);
  });

  it("respects explicit stored false with a user-choice marker", async () => {
    const { KEYS, getSettings } = await import("../lib/storage");
    const { loadCloudFallbackConsent } = await import("../lib/localAssistantSettings");

    writeStoredSettings(KEYS.settings, {
      allowCloudFallback: false,
      cloudFallbackUserChoice: true,
    });

    await expect(getSettings()).resolves.toMatchObject({
      allowCloudFallback: false,
      cloudFallbackUserChoice: true,
    });
    await expect(loadCloudFallbackConsent()).resolves.toBe(false);
  });

  it("persists enabled cloud fallback locally", async () => {
    const { DEFAULTS, KEYS, getSettings, setSettings } = await import("../lib/storage");

    await setSettings({
      ...DEFAULTS.settings,
      allowCloudFallback: true,
    });

    const stored = readStoredSettings(KEYS.settings);

    expect(stored.allowCloudFallback).toBe(true);
    expect(stored.cloudFallbackUserChoice).toBeUndefined();
    await expect(getSettings()).resolves.toMatchObject({
      allowCloudFallback: true,
    });
  });

  it("persists an explicit disabled cloud fallback choice", async () => {
    const { DEFAULTS, KEYS, getSettings, setSettings } = await import("../lib/storage");

    await setSettings({
      ...DEFAULTS.settings,
      allowCloudFallback: false,
      cloudFallbackUserChoice: true,
    });

    const stored = readStoredSettings(KEYS.settings);

    expect(stored.allowCloudFallback).toBe(false);
    expect(stored.cloudFallbackUserChoice).toBe(true);
    await expect(getSettings()).resolves.toMatchObject({
      allowCloudFallback: false,
      cloudFallbackUserChoice: true,
    });
  });
});
