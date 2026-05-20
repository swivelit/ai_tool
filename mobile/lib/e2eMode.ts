import Constants from "expo-constants";

import type { UserProfile } from "./account";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

export const E2E_MOCK_USER_UID = "e2e-mock-user";
export const E2E_MOCK_USER_EMAIL = "e2e@local.test";
export const E2E_MOCK_USER_ID = 900001;

function normalizeFlag(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function isTruthy(value: unknown) {
  return ["1", "true", "yes", "y", "on"].includes(normalizeFlag(value));
}

function publicEnv(name: string) {
  return extra[name] ?? (globalThis as any)?.process?.env?.[name];
}

function isDevOrTestRuntime() {
  const nodeEnv = normalizeFlag((globalThis as any)?.process?.env?.NODE_ENV);
  return Boolean((globalThis as any).__DEV__) || nodeEnv === "development" || nodeEnv === "test";
}

export function isAnyE2eEnvEnabled() {
  return (
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_AUTH")) ||
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP")) ||
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_VOICE_TURN"))
  );
}

export function assertE2eModeAllowed() {
  if (isAnyE2eEnvEnabled() && !isDevOrTestRuntime()) {
    throw new Error(
      "E2E mock auth/model setup/voice flags are debug/dev-only. Disable EXPO_PUBLIC_E2E_MOCK_AUTH, EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP, and EXPO_PUBLIC_E2E_MOCK_VOICE_TURN for release/production builds.",
    );
  }
}

export function isE2eMockAuthEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_AUTH"));
}

export function isE2eSkipModelSetupEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP"));
}

export function isE2eMockVoiceTurnEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_VOICE_TURN"));
}

export function getE2eMockUserProfile(): UserProfile {
  assertE2eModeAllowed();
  return {
    userId: E2E_MOCK_USER_ID,
    firebaseUid: E2E_MOCK_USER_UID,
    firebaseEmailVerified: true,
    name: "E2E Tester",
    place: "Local Device",
    timezone: "Asia/Kolkata",
    assistantName: "Elli",
    email: E2E_MOCK_USER_EMAIL,
    authProvider: "password",
    questionnaireCompleted: true,
    replyLanguage: "en",
  };
}

export function getE2eMockFirebaseUser() {
  assertE2eModeAllowed();
  return {
    uid: E2E_MOCK_USER_UID,
    email: E2E_MOCK_USER_EMAIL,
    displayName: "E2E Tester",
    emailVerified: true,
    isAnonymous: false,
    providerId: "firebase",
    providerData: [
      {
        providerId: "password",
        uid: E2E_MOCK_USER_EMAIL,
        email: E2E_MOCK_USER_EMAIL,
        displayName: "E2E Tester",
        phoneNumber: null,
        photoURL: null,
      },
    ],
    reload: async () => undefined,
    getIdToken: async () => "e2e-local-token",
    getIdTokenResult: async () => ({
      token: "e2e-local-token",
      claims: {},
      authTime: new Date(0).toISOString(),
      issuedAtTime: new Date(0).toISOString(),
      expirationTime: new Date(Date.now() + 3600000).toISOString(),
      signInProvider: "password",
      signInSecondFactor: null,
    }),
    toJSON: () => ({
      uid: E2E_MOCK_USER_UID,
      email: E2E_MOCK_USER_EMAIL,
      displayName: "E2E Tester",
    }),
  };
}
