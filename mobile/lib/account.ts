import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiDelete, apiGet, apiPost } from "./api";

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

function normalizeEmail(email?: string | null) {
  const value = (email || "").trim().toLowerCase();
  return value || undefined;
}

function mapBackendUserToProfile(user: any): UserProfile | null {
  if (!user || typeof user !== "object") return null;

  const resolvedUserId = normalizeUserId(user);
  if (!resolvedUserId) return null;

  return {
    userId: resolvedUserId,
    firebaseUid: typeof user.firebase_uid === "string" ? user.firebase_uid : undefined,
    name: String(user.name || "User"),
    place: typeof user.place === "string" ? user.place : "",
    timezone: typeof user.timezone === "string" && user.timezone.trim()
      ? user.timezone
      : "Asia/Kolkata",
    assistantName:
      typeof user.assistant_name === "string" && user.assistant_name.trim()
        ? user.assistant_name
        : "Elli",
    email: normalizeEmail(user.email) || undefined,
    questionnaireCompleted: Boolean(user.questionnaire_completed),
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

  const query = new URLSearchParams();

  if (normalizedUid) {
    query.set("firebase_uid", normalizedUid);
  }

  if (normalizedEmail) {
    query.set("email", normalizedEmail);
  }

  const response = await apiGet<BackendResolvedUserResponse>(`/users/resolve?${query.toString()}`);

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

async function writeProfileCache(profile: UserProfile) {
  const writes: Promise<any>[] = [
    AsyncStorage.setItem(KEY, JSON.stringify(profile)),
    AsyncStorage.setItem(BACKUP_KEY, JSON.stringify(profile)),
  ];

  if (profile.userId) {
    writes.push(AsyncStorage.setItem(LAST_USER_ID_KEY, String(profile.userId)));
  }

  if (profile.firebaseUid) {
    writes.push(AsyncStorage.setItem(LAST_FIREBASE_UID_KEY, profile.firebaseUid));
  }

  await Promise.all(writes);
}

async function restoreProfileFromBackup(): Promise<UserProfile | null> {
  const [backupRaw, lastUserIdRaw, lastFirebaseUid] = await Promise.all([
    AsyncStorage.getItem(BACKUP_KEY),
    AsyncStorage.getItem(LAST_USER_ID_KEY),
    AsyncStorage.getItem(LAST_FIREBASE_UID_KEY),
  ]);

  const backupProfile = safeParseProfile(backupRaw);
  if (backupProfile) {
    await AsyncStorage.setItem(KEY, JSON.stringify(backupProfile));
    return backupProfile;
  }

  const numericUserId = lastUserIdRaw ? Number(lastUserIdRaw) : NaN;
  if (Number.isFinite(numericUserId) && numericUserId > 0) {
    const rebuilt: UserProfile = {
      userId: numericUserId,
      firebaseUid: lastFirebaseUid || undefined,
      name: "User",
      place: "",
      timezone: "Asia/Kolkata",
      assistantName: "Elli",
      questionnaireCompleted: false,
    };

    await writeProfileCache(rebuilt);
    return rebuilt;
  }

  return null;
}

export async function getProfile(): Promise<UserProfile | null> {
  const raw = await AsyncStorage.getItem(KEY);
  const parsed = safeParseProfile(raw);

  if (parsed) {
    return parsed;
  }

  return restoreProfileFromBackup();
}

export async function getProfileForFirebaseUid(
  firebaseUid?: string | null,
  email?: string | null
) {
  const normalizedUid = (firebaseUid || "").trim();
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedUid && !normalizedEmail) return null;

  const profile = await getProfile();

  if (profile) {
    const sameUid = normalizedUid && profile.firebaseUid === normalizedUid;
    const sameEmail = normalizedEmail && normalizeEmail(profile.email) === normalizedEmail;

    if (sameUid || sameEmail) {
      const patched: UserProfile = {
        ...profile,
        firebaseUid: normalizedUid || profile.firebaseUid,
        email: normalizedEmail || profile.email,
      };
      await writeProfileCache(patched);
      return patched;
    }

    if (!profile.firebaseUid && normalizedUid) {
      const patched: UserProfile = {
        ...profile,
        firebaseUid: normalizedUid,
        email: normalizedEmail || profile.email,
      };
      await writeProfileCache(patched);
      return patched;
    }

    const lastFirebaseUid = await AsyncStorage.getItem(LAST_FIREBASE_UID_KEY);
    if (normalizedUid && lastFirebaseUid === normalizedUid && profile.userId) {
      const patched: UserProfile = {
        ...profile,
        firebaseUid: normalizedUid,
        email: normalizedEmail || profile.email,
      };
      await writeProfileCache(patched);
      return patched;
    }
  }

  try {
    const restored = await resolveProfileFromBackendByAuth(normalizedUid, normalizedEmail);

    if (!restored) {
      return null;
    }

    const merged: UserProfile = {
      ...restored,
      firebaseUid: normalizedUid || restored.firebaseUid,
      email: normalizedEmail || restored.email,
    };

    await writeProfileCache(merged);
    return merged;
  } catch (error) {
    console.warn("[account] Failed to resolve profile from backend:", error);
    return null;
  }
}

export async function saveProfile(profile: UserProfile) {
  await writeProfileCache(profile);
}

export async function clearProfile() {
  await Promise.all([
    AsyncStorage.removeItem(KEY),
    AsyncStorage.removeItem(BACKUP_KEY),
    AsyncStorage.removeItem(LAST_USER_ID_KEY),
    AsyncStorage.removeItem(LAST_FIREBASE_UID_KEY),
  ]);
}

export async function createProfileOnBackend(profile: UserProfile) {
  const requestBody = {
    user_id: profile.userId,
    firebase_uid: profile.firebaseUid,
    email: normalizeEmail(profile.email) || undefined,
    name: profile.name,
    place: profile.place,
    timezone: profile.timezone || "Asia/Kolkata",
    assistant_name: profile.assistantName || "Elli",
  };

  console.log("[account] POST /users request:", safeStringify(requestBody));

  const user = await apiPost<any>("/users", requestBody);

  console.log("[account] POST /users raw response:", safeStringify(user));

  const resolvedUserId = normalizeUserId(user);

  console.log("[account] POST /users resolved userId:", resolvedUserId);

  if (!resolvedUserId) {
    throw new Error(
      `Backend user id was missing in /users response. Raw response: ${safeStringify(user)}`
    );
  }

  const backendProfile = mapBackendUserToProfile(user) || null;

  const merged: UserProfile = {
    ...profile,
    ...backendProfile,
    userId: resolvedUserId,
    firebaseUid: profile.firebaseUid || backendProfile?.firebaseUid,
    email: normalizeEmail(profile.email) || backendProfile?.email,
    questionnaireCompleted:
      backendProfile?.questionnaireCompleted ?? profile.questionnaireCompleted ?? false,
  };

  await saveProfile(merged);

  console.log("[account] Saved profile:", safeStringify(merged));

  return merged;
}

export async function markQuestionnaireCompleted(done: boolean = true) {
  const profile = await getProfile();
  if (!profile) return null;

  const updated: UserProfile = {
    ...profile,
    questionnaireCompleted: done,
  };

  await saveProfile(updated);
  return updated;
}

export async function getPersonalityQuestions(): Promise<PersonalityQuestion[]> {
  const out = await apiGet<{ questions?: PersonalityQuestion[] }>("/api/questions");
  return Array.isArray(out?.questions) ? out.questions : [];
}

export async function savePersonalityAnswers(userId: number, answers: PersonalityAnswers) {
  const normalized = Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : String(value ?? ""),
    ])
  ) as Record<string, string>;

  return apiPost(`/users/${userId}/personality`, { answers: normalized });
}

export async function submitQuestionnaire(userId: number, payload: any) {
  return apiPost(`/users/${userId}/questionnaire`, { payload });
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