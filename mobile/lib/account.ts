import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiPost } from "./api";

const KEY = "user_profile_v1";

export type UserProfile = {
  userId?: number;
  name: string;
  place?: string;
  timezone?: string;
  assistantName?: string;
};

export async function getProfile(): Promise<UserProfile | null> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function saveProfile(p: UserProfile) {
  await AsyncStorage.setItem(KEY, JSON.stringify(p));
}

export async function createProfileOnBackend(p: UserProfile) {
  const u = await apiPost<any>("/users", {
    name: p.name,
    place: p.place,
    timezone: p.timezone || "Asia/Kolkata",
    assistant_name: p.assistantName || "Ellie",
  });
  const merged = { ...p, userId: u.id };
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
