import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiDelete, apiGet, apiPost, getApiErrorDetails } from "./api";

let SecureStore: any = null;
try {
  // Optional at test/runtime startup; add expo-secure-store to dependencies for encrypted storage.
  SecureStore = require("expo-secure-store");
} catch {
  SecureStore = null;
}

const KEY = "user_profile_v1";
const BACKUP_KEY = "user_profile_v1_backup";
const LAST_USER_ID_KEY = "last_user_id_v1";
const LAST_FIREBASE_UID_KEY = "last_firebase_uid_v1";

export type UserProfile = {
  userId?: number;
  firebaseUid?: string;
  firebaseEmailVerified?: boolean;
  name: string;
  place?: string;
  timezone?: string;
  assistantName?: string;
  email?: string;
  avatarUrl?: string;
  authProvider?: "password" | "google";
  questionnaireCompleted?: boolean;
  replyLanguage?: "en" | "ta";
  profileSummary?: string;
  communicationTone?: string;
  answerLength?: string;
  tamilStyle?: string;
  onboardingAnswers?: Record<string, unknown>;
  restoreFailed?: boolean;
};

export type PersonalityQuestion = {
  id: string;
  prompt: string;
  type: "single" | "multi";
  max_choices?: number;
  options: string[];
};

export type PersonalityAnswers = Record<string, string | string[]>;

type BackendResolvedUserResponse = {
  found?: boolean;
  user?: any;
};

export class BackendProfileRestoreError extends Error {
  constructor(message = "We could not restore your profile. Check your connection and try again.") {
    super(message);
    this.name = "BackendProfileRestoreError";
  }
}

export type BackendProfileErrorKind = "auth_error" | "backend_error" | "offline";

export type BackendProfileErrorDetails = ReturnType<typeof getApiErrorDetails> & {
  kind: BackendProfileErrorKind;
  debugMessage: string;
  userMessage: string;
};

export type ProfileRestoreResult =
  | { status: "ok"; profile: UserProfile }
  | { status: "not_found" }
  | {
      status: "offline";
      error: BackendProfileErrorDetails;
      cachedProfile?: UserProfile;
    }
  | {
      status: "auth_error";
      error: BackendProfileErrorDetails;
      cachedProfile?: UserProfile;
    }
  | {
      status: "backend_error";
      error: BackendProfileErrorDetails;
      cachedProfile?: UserProfile;
    };

function statusLabel(status?: number) {
  if (status === 408) return "timeout";
  if (status === 0 || typeof status === "undefined") return "network error";
  return String(status);
}

export function classifyBackendProfileError(
  error: unknown,
  fallback: { method: string; path: string },
  operation = "Backend profile restore failed"
): BackendProfileErrorDetails {
  const details = getApiErrorDetails(error, fallback);
  const status = details.status;
  const kind: BackendProfileErrorKind =
    status === 401 || status === 403
      ? "auth_error"
      : status === 408 || status === 0 || typeof status === "undefined"
        ? "offline"
        : "backend_error";
  const method = details.method || fallback.method;
  const path = details.path || fallback.path;
  const debugMessage = `${operation}: ${method} ${path} returned ${statusLabel(status)}.`;
  const userMessage =
    kind === "auth_error"
      ? "We could not verify your login with the backend. Please retry, or sign in again if it continues."
      : kind === "offline"
        ? "We could not reach the backend. Check your connection and try again."
        : "The backend could not restore your profile right now. Please try again.";

  return {
    ...details,
    kind,
    method,
    path,
    debugMessage,
    userMessage,
  };
}

async function secureSet(key: string, value: string) {
  if (SecureStore?.setItemAsync) {
    await SecureStore.setItemAsync(key, value);
    await AsyncStorage.removeItem(key).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(key, value);
}

async function secureGet(key: string) {
  if (SecureStore?.getItemAsync) {
    const secureValue = await SecureStore.getItemAsync(key);
    if (secureValue !== null && typeof secureValue !== "undefined") {
      return secureValue;
    }
  }
  return AsyncStorage.getItem(key);
}

async function secureDelete(key: string) {
  await Promise.all([
    SecureStore?.deleteItemAsync ? SecureStore.deleteItemAsync(key).catch(() => undefined) : Promise.resolve(),
    AsyncStorage.removeItem(key),
  ]);
}

function normalizeEmail(email?: string | null) {
  const value = (email || "").trim().toLowerCase();
  return value || undefined;
}

function mapBackendUserToProfile(user: any): UserProfile | null {
  if (!user || typeof user !== "object") return null;

  const resolvedUserId = normalizeUserId(user);
  if (!resolvedUserId) return null;

  const rawQuestionnaireCompleted =
    user.questionnaire_completed ?? user.questionnaireCompleted;
  const parsedQuestionnaireCompleted =
    typeof rawQuestionnaireCompleted === "boolean"
      ? rawQuestionnaireCompleted
      : typeof rawQuestionnaireCompleted === "string"
        ? parseBooleanString(rawQuestionnaireCompleted) === true
        : false;

  return {
    userId: resolvedUserId,
    firebaseUid: typeof user.firebase_uid === "string" ? user.firebase_uid : undefined,
    name: String(user.name || "User"),
    place: typeof user.place === "string" ? user.place : "",
    timezone:
      typeof user.timezone === "string" && user.timezone.trim()
        ? user.timezone
        : "Asia/Kolkata",
    assistantName:
      typeof user.assistant_name === "string" && user.assistant_name.trim()
        ? user.assistant_name
        : "Elli",
    email: normalizeEmail(user.email) || undefined,
    questionnaireCompleted: parsedQuestionnaireCompleted,
    replyLanguage: user.reply_language === "en" ? "en" : "ta",
    profileSummary:
      typeof (user.profile_summary ?? user.profileSummary) === "string"
        ? user.profile_summary ?? user.profileSummary
        : undefined,
    communicationTone:
      typeof (user.communication_tone ?? user.communicationTone) === "string"
        ? user.communication_tone ?? user.communicationTone
        : undefined,
    answerLength:
      typeof (user.answer_length ?? user.answerLength) === "string"
        ? user.answer_length ?? user.answerLength
        : undefined,
    tamilStyle:
      typeof (user.tamil_style ?? user.tamilStyle) === "string"
        ? user.tamil_style ?? user.tamilStyle
        : undefined,
    onboardingAnswers:
      user.onboarding_answers && typeof user.onboarding_answers === "object"
        ? user.onboarding_answers
        : user.onboardingAnswers && typeof user.onboardingAnswers === "object"
          ? user.onboardingAnswers
          : undefined,
  };
}

async function resolveProfileFromBackendByAuth(
  firebaseUid?: string | null,
  email?: string | null
): Promise<UserProfile | null> {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUid = (firebaseUid || "").trim();

  if (!normalizedUid && !normalizedEmail) {
    return null;
  }

  const response = await apiGet<BackendResolvedUserResponse>("/users/resolve");

  if (!response?.found || !response.user) {
    return null;
  }

  return mapBackendUserToProfile(response.user);
}

function safeParseProfile(raw: string | null): UserProfile | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as UserProfile;
  } catch {
    return null;
  }
}

function stripRuntimeProfileFlags(profile: UserProfile): UserProfile {
  const sanitized: UserProfile = { ...profile };
  delete sanitized.restoreFailed;
  return sanitized;
}

function normalizeCachedProfile(profile: UserProfile | null): UserProfile | null {
  if (!profile) return null;

  if (profile.restoreFailed && !profile.userId) {
    return null;
  }

  return stripRuntimeProfileFlags(profile);
}

function toPositiveNumber(value: any): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  return undefined;
}

function normalizeKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tryParseJsonString(value: any) {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeUserId(payload: any): number | undefined {
  const parsedPayload = tryParseJsonString(payload);

  const directCandidates = [
    parsedPayload?.id,
    parsedPayload?.userId,
    parsedPayload?.user_id,
    parsedPayload?.backendUserId,
    parsedPayload?.backend_user_id,

    parsedPayload?.data?.id,
    parsedPayload?.data?.userId,
    parsedPayload?.data?.user_id,
    parsedPayload?.data?.backendUserId,
    parsedPayload?.data?.backend_user_id,

    parsedPayload?.user?.id,
    parsedPayload?.user?.userId,
    parsedPayload?.user?.user_id,
    parsedPayload?.user?.backendUserId,
    parsedPayload?.user?.backend_user_id,

    parsedPayload?.data?.user?.id,
    parsedPayload?.data?.user?.userId,
    parsedPayload?.data?.user?.user_id,
    parsedPayload?.data?.user?.backendUserId,
    parsedPayload?.data?.user?.backend_user_id,

    parsedPayload?.profile?.id,
    parsedPayload?.profile?.userId,
    parsedPayload?.profile?.user_id,

    parsedPayload?.result?.id,
    parsedPayload?.result?.userId,
    parsedPayload?.result?.user_id,
  ];

  for (const value of directCandidates) {
    const resolved = toPositiveNumber(value);
    if (resolved) {
      return resolved;
    }
  }

  const targetKeys = new Set(["id", "userid", "backenduserid"]);
  const queue: any[] = [parsedPayload];
  const visited = new Set<any>();
  let steps = 0;

  while (queue.length && steps < 200) {
    steps += 1;
    const current = tryParseJsonString(queue.shift());

    if (!current || typeof current !== "object") {
      const primitiveResolved = toPositiveNumber(current);
      if (primitiveResolved) {
        return primitiveResolved;
      }
      continue;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      const normalized = normalizeKey(key);

      if (targetKeys.has(normalized)) {
        const resolved = toPositiveNumber(value);
        if (resolved) {
          return resolved;
        }
      }

      if (value && typeof value === "object") {
        queue.push(value);
      } else if (typeof value === "string") {
        const maybeParsed = tryParseJsonString(value);
        if (maybeParsed !== value) {
          queue.push(maybeParsed);
        }
      }
    }
  }

  return undefined;
}

function safeStringify(value: any) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveQuestionnaireCompleted(
  _localValue?: boolean,
  remoteValue?: boolean
): boolean {
  return remoteValue === true;
}

function parseBooleanString(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function mergeProfileWithAuth(
  profile: UserProfile,
  firebaseUid?: string | null,
  email?: string | null
): UserProfile {
  const normalizedUid = (firebaseUid || "").trim() || undefined;
  const normalizedEmail = normalizeEmail(email);

  return {
    ...profile,
    firebaseUid: normalizedUid || profile.firebaseUid,
    email: normalizedEmail || normalizeEmail(profile.email) || undefined,
  };
}

function getAuthMatchKind(
  profile: UserProfile,
  firebaseUid?: string | null,
  _email?: string | null
): "uid" | null {
  const normalizedUid = (firebaseUid || "").trim();
  const profileUid = (profile.firebaseUid || "").trim();

  if (normalizedUid && profileUid && normalizedUid === profileUid) {
    return "uid";
  }

  return null;
}

async function clearCachedProfileKeys() {
  await Promise.all([
    secureDelete(KEY),
    secureDelete(BACKUP_KEY),
    secureDelete(LAST_USER_ID_KEY),
    secureDelete(LAST_FIREBASE_UID_KEY),
  ]);
}

async function writeProfileCache(profile: UserProfile) {
  const cacheableProfile = stripRuntimeProfileFlags(profile);
  const writes: Promise<any>[] = [
    secureSet(KEY, JSON.stringify(cacheableProfile)),
    secureSet(BACKUP_KEY, JSON.stringify(cacheableProfile)),
  ];

  if (cacheableProfile.userId) {
    writes.push(secureSet(LAST_USER_ID_KEY, String(cacheableProfile.userId)));
  }

  if (cacheableProfile.firebaseUid) {
    writes.push(secureSet(LAST_FIREBASE_UID_KEY, cacheableProfile.firebaseUid));
  }

  await Promise.all(writes);
}

async function readCachedProfile(): Promise<UserProfile | null> {
  const raw = await secureGet(KEY);
  const parsed = safeParseProfile(raw);
  const normalized = normalizeCachedProfile(parsed);

  if (normalized) {
    if (parsed?.restoreFailed) {
      await secureSet(KEY, JSON.stringify(normalized));
    }
    return normalized;
  }

  if (parsed?.restoreFailed) {
    await secureDelete(KEY);
  }

  const backupRaw = await secureGet(BACKUP_KEY);
  const backup = safeParseProfile(backupRaw);
  const normalizedBackup = normalizeCachedProfile(backup);

  if (normalizedBackup) {
    await secureSet(KEY, JSON.stringify(normalizedBackup));
    if (backup?.restoreFailed) {
      await secureSet(BACKUP_KEY, JSON.stringify(normalizedBackup));
    }
    return normalizedBackup;
  }

  if (backup?.restoreFailed) {
    await secureDelete(BACKUP_KEY);
  }

  return null;
}

export async function getProfile(): Promise<UserProfile | null> {
  return readCachedProfile();
}

export async function restoreProfileForFirebaseUid(
  firebaseUid?: string | null,
  email?: string | null
): Promise<ProfileRestoreResult> {
  const normalizedUid = (firebaseUid || "").trim();
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedUid && !normalizedEmail) {
    return { status: "not_found" };
  }

  const cachedProfile = await readCachedProfile();
  const cachedMatch = cachedProfile
    ? getAuthMatchKind(cachedProfile, normalizedUid, normalizedEmail)
    : null;
  const matchedCachedProfile = cachedProfile && cachedMatch ? cachedProfile : null;

  if (cachedProfile && !matchedCachedProfile) {
    console.warn("[account] Cached profile belongs to a different auth identity. Clearing stale local profile.");

    await clearCachedProfileKeys();
  }

  try {
    const restored = await resolveProfileFromBackendByAuth(normalizedUid, normalizedEmail);

    if (restored) {
      const merged: UserProfile = {
        ...mergeProfileWithAuth(restored, normalizedUid, normalizedEmail),
        questionnaireCompleted: resolveQuestionnaireCompleted(
          undefined,
          restored.questionnaireCompleted
        ),
      };

      await writeProfileCache(merged);
      return { status: "ok", profile: merged };
    }
  } catch (error) {
    const details = classifyBackendProfileError(
      error,
      { method: "GET", path: "/users/resolve" },
      "Backend profile restore failed"
    );
    console.warn("[account] Failed to resolve profile from backend.", details);

    const patchedCachedProfile = matchedCachedProfile
      ? mergeProfileWithAuth(matchedCachedProfile, normalizedUid, normalizedEmail)
      : undefined;

    if (patchedCachedProfile) {
      await writeProfileCache(patchedCachedProfile);
    }

    return {
      status: details.kind,
      error: details,
      cachedProfile: patchedCachedProfile,
    };
  }

  if (matchedCachedProfile) {
    const patched = mergeProfileWithAuth(
      matchedCachedProfile,
      normalizedUid,
      normalizedEmail
    );

    await writeProfileCache(patched);
    return { status: "ok", profile: patched };
  }

  return { status: "not_found" };
}

export async function getProfileForFirebaseUid(
  firebaseUid?: string | null,
  email?: string | null
) {
  const result = await restoreProfileForFirebaseUid(firebaseUid, email);

  if (result.status === "ok") {
    return result.profile;
  }

  if ("cachedProfile" in result && result.cachedProfile) {
    return result.cachedProfile;
  }

  return null;
}

export async function saveProfile(profile: UserProfile) {
  await writeProfileCache(profile);
}

export async function clearProfile() {
  await clearCachedProfileKeys();
}

export async function createProfileOnBackend(profile: UserProfile) {
  const profileForRequest = stripRuntimeProfileFlags(profile);
  const requestBody = {
    firebase_uid: profileForRequest.firebaseUid,
    email: normalizeEmail(profileForRequest.email) || undefined,
    name: profileForRequest.name,
    place: profileForRequest.place,
    timezone: profileForRequest.timezone || "Asia/Kolkata",
    assistant_name: profileForRequest.assistantName || "Elli",
    reply_language: profileForRequest.replyLanguage === "en" ? "en" : "ta",
  };

  let user: any;
  try {
    user = await apiPost<any>("/users", requestBody);
  } catch (error) {
    console.warn(
      "[account] Failed to create or update profile on backend.",
      classifyBackendProfileError(
        error,
        { method: "POST", path: "/users" },
        "Backend profile sync failed"
      )
    );
    throw error;
  }

  const resolvedUserId = normalizeUserId(user);

  if (!resolvedUserId) {
    throw new Error(
      "Backend user id was missing in /users response."
    );
  }

  const backendProfile = mapBackendUserToProfile(user) || null;

  const merged: UserProfile = {
    ...profileForRequest,
    ...backendProfile,
    userId: resolvedUserId,
    firebaseUid: profileForRequest.firebaseUid || backendProfile?.firebaseUid,
    email: normalizeEmail(profileForRequest.email) || backendProfile?.email,
    questionnaireCompleted: resolveQuestionnaireCompleted(
      undefined,
      backendProfile?.questionnaireCompleted
    ),
    replyLanguage: profileForRequest.replyLanguage || backendProfile?.replyLanguage || "ta",
  };

  await saveProfile(merged);

  return merged;
}

export async function getPersonalityQuestions(): Promise<PersonalityQuestion[]> {
  const out = await apiGet<{ questions?: PersonalityQuestion[] }>("/api/questions");
  return Array.isArray(out?.questions) ? out.questions : [];
}

export async function savePersonalityAnswers(
  userId: number,
  answers: PersonalityAnswers
) {
  const normalized = Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : String(value ?? ""),
    ])
  ) as PersonalityAnswers;

  return apiPost(`/users/${userId}/personality`, { answers: normalized });
}

export async function generateDailyCheckins(userId: number) {
  return apiPost<{ checkins: { title: string; when: string; message: string }[] }>(
    `/users/${userId}/generate-daily-checkins`,
    {}
  );
}

export async function deleteAccountOnBackend(userId: number) {
  return apiDelete<{ ok: boolean; deleted_user_id: number }>(`/users/${userId}`);
}
