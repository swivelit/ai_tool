import { afterEach, describe, expect, it, vi } from "vitest";

const FIREBASE_ENV_NAMES = [
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "EXPO_PUBLIC_FIREBASE_APP_ID",
];

async function withFirebaseEnv<T>(
  env: Record<string, string | undefined>,
  callback: () => Promise<T>,
) {
  const previous = new Map<string, string | undefined>();
  for (const key of FIREBASE_ENV_NAMES) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

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

    await withFirebaseEnv({}, async () => {
      const { getInitializeAuthOptions } = await import("@/lib/firebase");

      expect(getInitializeAuthOptions("web")).toBeUndefined();
    });
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
    const { getInitializeAuthOptions } = await withFirebaseEnv({}, () =>
      import("@/lib/firebase")
    );

    expect(getInitializeAuthOptions("android", getReactNativePersistence)).toEqual({
      persistence,
    });
    expect(getReactNativePersistence).toHaveBeenCalledTimes(1);
  });

  it("initializes Firebase Auth when config is complete", async () => {
    vi.resetModules();
    const app = { name: "app" };
    const nativeAuth = { name: "native-auth" };
    const fallbackAuth = { name: "fallback-auth" };
    const persistence = { kind: "async-storage" };
    const initializeApp = vi.fn(() => app);
    const getApp = vi.fn();
    const getApps = vi.fn(() => []);
    const initializeAuth = vi.fn(() => nativeAuth);
    const getAuth = vi.fn(() => fallbackAuth);
    const getReactNativePersistence = vi.fn(() => persistence);

    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {
            firebaseApiKey: "key",
            firebaseAuthDomain: "domain",
            firebaseProjectId: "project",
            firebaseStorageBucket: "bucket",
            firebaseMessagingSenderId: "sender",
            firebaseAppId: "app-id",
          },
        },
      },
    }));
    vi.doMock("react-native", () => ({
      Platform: { OS: "android" },
    }));
    vi.doMock("firebase/app", () => ({
      getApps,
      getApp,
      initializeApp,
    }));
    vi.doMock("firebase/auth", () => ({
      getAuth,
      getReactNativePersistence,
      initializeAuth,
    }));
    vi.doMock("@react-native-async-storage/async-storage", () => ({
      default: { store: "async-storage" },
    }));

    const imported = await withFirebaseEnv({}, () => import("@/lib/firebase"));

    expect(imported.firebaseConfigStatus).toEqual({
      configured: true,
      missingKeys: [],
    });
    expect(initializeApp).toHaveBeenCalledWith({
      apiKey: "key",
      authDomain: "domain",
      projectId: "project",
      storageBucket: "bucket",
      messagingSenderId: "sender",
      appId: "app-id",
    });
    expect(getReactNativePersistence).toHaveBeenCalledWith({ store: "async-storage" });
    expect(initializeAuth).toHaveBeenCalledWith(app, { persistence });
    expect(getAuth).not.toHaveBeenCalled();
    expect(imported.firebaseApp).toBe(app);
    expect(imported.auth).toBe(nativeAuth);
    expect(imported.requireFirebaseAuth()).toBe(nativeAuth);
  });

  it("does not throw on import when Firebase config is missing", async () => {
    vi.resetModules();
    const initializeApp = vi.fn();
    const getAuth = vi.fn();
    const initializeAuth = vi.fn();

    vi.doMock("expo-constants", () => ({
      default: {
        expoConfig: {
          extra: {},
        },
      },
    }));
    vi.doMock("react-native", () => ({
      Platform: { OS: "android" },
    }));
    vi.doMock("firebase/app", () => ({
      getApps: vi.fn(() => []),
      getApp: vi.fn(),
      initializeApp,
    }));
    vi.doMock("firebase/auth", () => ({
      getAuth,
      initializeAuth,
    }));

    const imported = await withFirebaseEnv({}, () => import("@/lib/firebase"));

    expect(imported.firebaseConfigStatus.configured).toBe(false);
    expect(imported.firebaseConfigStatus.missingKeys).toEqual([
      "apiKey",
      "authDomain",
      "projectId",
      "storageBucket",
      "messagingSenderId",
      "appId",
    ]);
    expect(imported.firebaseConfigStatus.message).toContain("Missing Firebase config");
    expect(imported.firebaseConfigStatus.message).toContain("EXPO_PUBLIC_FIREBASE_*");
    expect(imported.firebaseApp).toBeNull();
    expect(imported.auth).toBeNull();
    expect(initializeApp).not.toHaveBeenCalled();
    expect(getAuth).not.toHaveBeenCalled();
    expect(initializeAuth).not.toHaveBeenCalled();
    expect(() => imported.requireFirebaseAuth()).toThrow(/Missing Firebase config/);
  });
});
