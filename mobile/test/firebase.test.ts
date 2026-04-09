import { describe, expect, it, vi } from "vitest";

describe("getInitializeAuthOptions", () => {
  it("returns undefined on web", async () => {
    vi.resetModules();
    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            firebaseApiKey: "key",
            firebaseAuthDomain: "domain",
            firebaseProjectId: "project",
            firebaseStorageBucket: "bucket",
            firebaseMessagingSenderId: "sender",
            firebaseAppId: "app",
          },
        },
      },
    }));
    vi.doMock("react-native", () => ({
      Platform: { OS: "web" },
    }));
    vi.doMock("firebase/app", () => ({
      getApps: () => [],
      getApp: vi.fn(),
      initializeApp: vi.fn(() => ({ name: "app" })),
    }));
    vi.doMock("firebase/auth", () => ({
      getAuth: vi.fn(() => ({ name: "web-auth" })),
      initializeAuth: vi.fn(() => ({ name: "native-auth" })),
    }));

    const { getInitializeAuthOptions } = await import("@/lib/firebase");

    expect(getInitializeAuthOptions("web")).toBeUndefined();
  });

  it("uses AsyncStorage persistence on native", async () => {
    vi.resetModules();
    const persistence = { kind: "async-storage" } as any;
    const getReactNativePersistence = vi.fn((storage: any) => {
      expect(storage).toEqual({ store: "async-storage" });
      return persistence;
    });

    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            firebaseApiKey: "key",
            firebaseAuthDomain: "domain",
            firebaseProjectId: "project",
            firebaseStorageBucket: "bucket",
            firebaseMessagingSenderId: "sender",
            firebaseAppId: "app",
          },
        },
      },
    }));
    vi.doMock("react-native", () => ({
      Platform: { OS: "web" },
    }));
    vi.doMock("firebase/app", () => ({
      getApps: () => [],
      getApp: vi.fn(),
      initializeApp: vi.fn(() => ({ name: "app" })),
    }));
    vi.doMock("firebase/auth", () => ({
      getAuth: vi.fn(() => ({ name: "fallback-auth" })),
      initializeAuth: vi.fn(() => ({ name: "native-auth" })),
    }));
    vi.doMock("@react-native-async-storage/async-storage", () => ({
      default: { store: "async-storage" },
    }));
    const { getInitializeAuthOptions } = await import("@/lib/firebase");

    expect(getInitializeAuthOptions("android", getReactNativePersistence)).toEqual({
      persistence,
    });
    expect(getReactNativePersistence).toHaveBeenCalledTimes(1);
  });
});
