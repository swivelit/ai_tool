import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

const apiGetMock = vi.hoisted(() => vi.fn());
const apiPostMock = vi.hoisted(() => vi.fn());

class MockApiError extends Error {
  status: number;
  method?: string;
  path?: string;
  endpoint?: string;
  apiBase?: string;

  constructor(message: string, status: number, method = "GET", path = "/users/resolve") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.apiBase = "https://api.example.test";
    this.endpoint = `${this.apiBase}${path}`;
  }
}

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

vi.mock("../lib/api", () => ({
  apiDelete: vi.fn(),
  apiGet: apiGetMock,
  apiPost: apiPostMock,
  API_BASE: "https://api.example.test",
  getApiErrorDetails: (error: any, fallback: { method?: string; path?: string } = {}) => ({
    name: error?.name || "Error",
    status: error?.status,
    message: error?.message || "Unknown error",
    method: error?.method || fallback.method,
    path: error?.path || fallback.path,
    endpoint:
      error?.endpoint ||
      (error?.path || fallback.path
        ? `https://api.example.test${error?.path || fallback.path}`
        : undefined),
    apiBase: error?.apiBase || "https://api.example.test",
  }),
}));

describe("profile restore", () => {
  beforeEach(async () => {
    storage.clear();
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { clearProfile } = await import("../lib/account");
    await clearProfile();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats found:false as not_found without caching a restore-failed profile", async () => {
    apiGetMock.mockResolvedValueOnce({ found: false });

    const { getProfile, getProfileForFirebaseUid, restoreProfileForFirebaseUid } =
      await import("../lib/account");

    await expect(restoreProfileForFirebaseUid("uid-1", "a@example.com")).resolves.toEqual({
      status: "not_found",
    });
    await expect(getProfileForFirebaseUid("uid-1", "a@example.com")).resolves.toBeNull();
    await expect(getProfile()).resolves.toBeNull();
  });

  it("does not cache a fake profile for 401 or 403 restore failures", async () => {
    apiGetMock.mockRejectedValueOnce(
      new MockApiError("GET /users/resolve failed: 401", 401)
    );

    const { getProfile, restoreProfileForFirebaseUid } = await import("../lib/account");
    const result = await restoreProfileForFirebaseUid("uid-1", "a@example.com");

    expect(result.status).toBe("auth_error");
    await expect(getProfile()).resolves.toBeNull();
  });

  it("does not cache a fake profile for 503 or timeout restore failures", async () => {
    apiGetMock.mockRejectedValueOnce(
      new MockApiError("GET /users/resolve failed: 503", 503)
    );

    const { getProfile, restoreProfileForFirebaseUid } = await import("../lib/account");
    const backendResult = await restoreProfileForFirebaseUid("uid-1", "a@example.com");

    expect(backendResult.status).toBe("backend_error");
    await expect(getProfile()).resolves.toBeNull();

    apiGetMock.mockRejectedValueOnce(new MockApiError("Request timed out", 408));
    const timeoutResult = await restoreProfileForFirebaseUid("uid-1", "a@example.com");

    expect(timeoutResult.status).toBe("offline");
    await expect(getProfile()).resolves.toBeNull();
  });

  it("uses a matching cached profile when the backend is temporarily unavailable", async () => {
    const { getProfileForFirebaseUid, restoreProfileForFirebaseUid, saveProfile } =
      await import("../lib/account");

    await saveProfile({
      userId: 7,
      firebaseUid: "uid-1",
      email: "a@example.com",
      name: "A",
      assistantName: "Elli",
      timezone: "Asia/Kolkata",
      questionnaireCompleted: true,
    });
    apiGetMock.mockRejectedValueOnce(new MockApiError("Request timed out", 408));

    const result = await restoreProfileForFirebaseUid("uid-1", "a@example.com");

    expect(result.status).toBe("offline");
    expect("cachedProfile" in result ? result.cachedProfile?.userId : undefined).toBe(7);

    apiGetMock.mockRejectedValueOnce(new MockApiError("Request timed out", 408));
    const profile = await getProfileForFirebaseUid("uid-1", "a@example.com");

    expect(profile?.userId).toBe(7);
    expect(profile?.restoreFailed).toBeUndefined();
  });
});
