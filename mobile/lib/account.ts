import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiPost } from "./api";

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
};

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
    assistant_name: profile.assistantName || "Ellie",
  });

  const merged = { ...profile, userId: user.id };
  await saveProfile(merged);
  return merged;
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