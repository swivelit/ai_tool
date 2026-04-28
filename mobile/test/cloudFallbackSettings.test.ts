import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    storage.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    storage.delete(key);
  }),
}));

describe("cloud fallback settings", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("defaults cloud fallback consent to false", async () => {
    const { getSettings } = await import("../lib/storage");
    const settings = await getSettings();

    expect(settings.allowCloudFallback).toBe(false);
  });

  it("persists explicit cloud fallback consent locally", async () => {
    const { DEFAULTS, getSettings, setSettings } = await import("../lib/storage");

    await setSettings({
      ...DEFAULTS.settings,
      allowCloudFallback: true,
    });

    await expect(getSettings()).resolves.toMatchObject({
      allowCloudFallback: true,
    });
  });
});
