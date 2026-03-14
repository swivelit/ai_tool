import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiGet, apiPost } from "./api";

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

function normalizeUserId(payload: any): number | undefined {
  const candidates = [
    payload?.id,
    payload?.userId,
    payload?.user_id,
    payload?.data?.id,
    payload?.data?.userId,
    payload?.data?.user_id,
  ];

  for (const value of candidates) {
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;

    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }

  return undefined;
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

export async function getProfileForFirebaseUid(firebaseUid?: string | null) {
  if (!firebaseUid) return null;

  const profile = await getProfile();
  if (!profile) return null;

  if (profile.firebaseUid === firebaseUid) {
    return profile;
  }

  if (!profile.firebaseUid) {
    const patched: UserProfile = {
      ...profile,
      firebaseUid,
    };
    await writeProfileCache(patched);
    return patched;
  }

  const lastFirebaseUid = await AsyncStorage.getItem(LAST_FIREBASE_UID_KEY);
  if (lastFirebaseUid === firebaseUid && profile.userId) {
    const patched: UserProfile = {
      ...profile,
      firebaseUid,
    };
    await writeProfileCache(patched);
    return patched;
  }

  return null;
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
  const user = await apiPost<any>("/users", {
    name: profile.name,
    place: profile.place,
    timezone: profile.timezone || "Asia/Kolkata",
    assistant_name: profile.assistantName || "Elli",
  });

  const resolvedUserId = normalizeUserId(user);
  if (!resolvedUserId) {
    throw new Error("Backend user id was missing in /users response.");
  }

  const merged: UserProfile = {
    ...profile,
    userId: resolvedUserId,
    questionnaireCompleted: profile.questionnaireCompleted ?? false,
  };

  await saveProfile(merged);
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