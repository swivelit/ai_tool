import AsyncStorage from "@react-native-async-storage/async-storage";

import { apiGet, apiPost } from "./api";

const KEY = "user_profile_v1";

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

export async function getProfile(): Promise<UserProfile | null> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function getProfileForFirebaseUid(firebaseUid?: string | null) {
  const profile = await getProfile();
  if (!profile) return null;
  if (!firebaseUid) return null;
  if (!profile.firebaseUid) return null;
  if (profile.firebaseUid !== firebaseUid) return null;
  return profile;
}

export async function saveProfile(profile: UserProfile) {
  await AsyncStorage.setItem(KEY, JSON.stringify(profile));
}

export async function clearProfile() {
  await AsyncStorage.removeItem(KEY);
}

export async function createProfileOnBackend(profile: UserProfile) {
  const user = await apiPost<any>("/users", {
    name: profile.name,
    place: profile.place,
    timezone: profile.timezone || "Asia/Kolkata",
    assistant_name: profile.assistantName || "Elli",
  });

  const merged: UserProfile = {
    ...profile,
    userId: user.id,
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