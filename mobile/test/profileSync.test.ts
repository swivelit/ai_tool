import { beforeEach, describe, expect, it, vi } from "vitest";

const restoreProfileForFirebaseUidMock = vi.hoisted(() => vi.fn());
const createProfileOnBackendMock = vi.hoisted(() => vi.fn());

const authError = {
  kind: "auth_error" as const,
  status: 401,
  message: "GET /users/resolve failed: 401",
  method: "GET",
  path: "/users/resolve",
  endpoint: "https://api.example.test/users/resolve",
  apiBase: "https://api.example.test",
  debugMessage: "Backend profile restore failed: GET /users/resolve returned 401.",
  userMessage: "We could not verify your login with the backend. Please retry.",
};

vi.mock("../lib/account", () => ({
  restoreProfileForFirebaseUid: restoreProfileForFirebaseUidMock,
  createProfileOnBackend: createProfileOnBackendMock,
  classifyBackendProfileError: (error: any) => ({
    kind: "backend_error" as const,
    status: error?.status || 503,
    message: error?.message || "POST /users failed",
    method: "POST",
    path: "/users",
    endpoint: "https://api.example.test/users",
    apiBase: "https://api.example.test",
    debugMessage: "Backend profile sync failed: POST /users returned 503.",
    userMessage: "The backend could not restore your profile right now. Please try again.",
  }),
}));

describe("syncProfileForAuthenticatedUser", () => {
  beforeEach(() => {
    restoreProfileForFirebaseUidMock.mockReset();
    createProfileOnBackendMock.mockReset();
  });

  it("does not create a backend profile when restore fails with auth_error", async () => {
    restoreProfileForFirebaseUidMock.mockResolvedValueOnce({
      status: "auth_error",
      error: authError,
    });

    const { syncProfileForAuthenticatedUser } = await import("../lib/profileSync");
    const result = await syncProfileForAuthenticatedUser({
      uid: "uid-1",
      email: "a@example.com",
      emailVerified: true,
      providerData: [{ providerId: "password" }],
    });

    expect(result.status).toBe("auth_error");
    expect(createProfileOnBackendMock).not.toHaveBeenCalled();
  });

  it("creates the backend profile for a new password user when restore returns not_found", async () => {
    restoreProfileForFirebaseUidMock.mockResolvedValueOnce({ status: "not_found" });
    createProfileOnBackendMock.mockResolvedValueOnce({
      userId: 8,
      firebaseUid: "uid-1",
      email: "a@example.com",
      name: "A",
      assistantName: "Elli",
      timezone: "Asia/Kolkata",
      questionnaireCompleted: false,
    });

    const { syncProfileForAuthenticatedUser } = await import("../lib/profileSync");
    const result = await syncProfileForAuthenticatedUser({
      uid: "uid-1",
      email: "a@example.com",
      emailVerified: true,
      providerData: [{ providerId: "password" }],
    });

    expect(result.status).toBe("ok");
    expect(createProfileOnBackendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        firebaseUid: "uid-1",
        email: "a@example.com",
        name: "a",
      })
    );
  });

  it("sends a new Google user to profile onboarding when no backend profile exists", async () => {
    restoreProfileForFirebaseUidMock.mockResolvedValueOnce({ status: "not_found" });

    const { syncProfileForAuthenticatedUser } = await import("../lib/profileSync");
    const result = await syncProfileForAuthenticatedUser({
      uid: "uid-google",
      email: "g@example.com",
      providerData: [{ providerId: "google.com" }],
    });

    expect(result.status).toBe("not_found");
    expect(createProfileOnBackendMock).not.toHaveBeenCalled();
  });

  it("does not let stale backend Tamil overwrite a locally changed English setting", async () => {
    const { resolveSettingsLanguageAfterProfileRestore } = await import("../lib/profileSync");

    expect(
      resolveSettingsLanguageAfterProfileRestore({
        storedLanguageMode: "en",
        backendReplyLanguage: "ta",
        localSettingsChangedThisSession: true,
      }),
    ).toBe("en");
  });

  it("hydrates Settings from backend reply language when there is no local session change", async () => {
    const { resolveSettingsLanguageAfterProfileRestore } = await import("../lib/profileSync");

    expect(
      resolveSettingsLanguageAfterProfileRestore({
        storedLanguageMode: "en",
        backendReplyLanguage: "ta",
        localSettingsChangedThisSession: false,
      }),
    ).toBe("ta");
  });
});
