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
  return (globalThis as any)?.process?.env?.[name] ?? extra[name];
}

function isDevOrTestRuntime() {
  const nodeEnv = normalizeFlag((globalThis as any)?.process?.env?.NODE_ENV);
  return Boolean((globalThis as any).__DEV__) || nodeEnv === "development" || nodeEnv === "test";
}

export function isAnyE2eEnvEnabled() {
  return (
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_AUTH")) ||
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_API")) ||
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP")) ||
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_VOICE_TURN")) ||
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE")) ||
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO")) ||
    isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT")) ||
    Boolean(normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_REPLY_LANGUAGE"))) ||
    Boolean(normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_TAMIL_STYLE"))) ||
    Boolean(normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_VOICE_QUERY"))) ||
    Boolean(normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_VOICE_SURFACE"))) ||
    Boolean(normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT"))) ||
    Boolean(normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE"))) ||
    Boolean(normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND")))
  );
}

export function assertE2eModeAllowed() {
  if (isAnyE2eEnvEnabled() && !isDevOrTestRuntime()) {
    throw new Error(
      "E2E mock auth/API/model setup/voice/life-context flags are debug/dev-only. Disable EXPO_PUBLIC_E2E_MOCK_AUTH, EXPO_PUBLIC_E2E_MOCK_API, EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP, EXPO_PUBLIC_E2E_MOCK_VOICE_TURN, EXPO_PUBLIC_E2E_MOCK_HANDS_FREE, EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO, EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT, EXPO_PUBLIC_E2E_REPLY_LANGUAGE, EXPO_PUBLIC_E2E_TAMIL_STYLE, EXPO_PUBLIC_E2E_VOICE_QUERY, EXPO_PUBLIC_E2E_VOICE_SURFACE, EXPO_PUBLIC_E2E_EXPECT_ORB_TRANSCRIPT, EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE, and EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND for release/production builds.",
    );
  }
}

export function isE2eMockAuthEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_AUTH"));
}

export function isE2eApiFixtureEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_API"));
}

export function isE2eSkipModelSetupEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_SKIP_MODEL_SETUP"));
}

export function isE2eMockVoiceTurnEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_VOICE_TURN"));
}

export function isE2eMockHandsFreeEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE"));
}

export function isE2eMockHandsFreeAudioEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE_AUDIO"));
}

export function isE2eMockLifeContextEnabled() {
  assertE2eModeAllowed();
  return isTruthy(publicEnv("EXPO_PUBLIC_E2E_MOCK_LIFE_CONTEXT"));
}

export function getE2eHandsFreeWakePhrase() {
  assertE2eModeAllowed();
  return String(publicEnv("EXPO_PUBLIC_E2E_HANDS_FREE_WAKE_PHRASE") || "").trim() || "Hey Elli";
}

export function getE2eHandsFreeCommand() {
  assertE2eModeAllowed();
  return String(publicEnv("EXPO_PUBLIC_E2E_HANDS_FREE_COMMAND") || "").trim() || "tell me about Spitzola";
}

export function getE2eReplyLanguage(): "en" | "ta" {
  assertE2eModeAllowed();
  return normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_REPLY_LANGUAGE")) === "ta"
    ? "ta"
    : "en";
}

export function getE2eTamilStyle() {
  assertE2eModeAllowed();
  return normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_TAMIL_STYLE")) || "chennai_conversational";
}

export function getE2eVoiceQuery() {
  assertE2eModeAllowed();
  const raw = String(publicEnv("EXPO_PUBLIC_E2E_VOICE_QUERY") || "").trim();
  if (raw.toLowerCase() === "spitzola") {
    return "Hey Elli, can you tell me about Spitzola? I think it's a disease or something.";
  }
  return raw || "e2e voice question";
}

export function getE2eVoiceSurface(): "live" | "quick" {
  assertE2eModeAllowed();
  return normalizeFlag(publicEnv("EXPO_PUBLIC_E2E_VOICE_SURFACE")) === "quick"
    ? "quick"
    : "live";
}

export function getE2eMockUserProfile(): UserProfile {
  assertE2eModeAllowed();
  const replyLanguage = getE2eReplyLanguage();
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
    replyLanguage,
    tamilStyle: getE2eTamilStyle(),
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
