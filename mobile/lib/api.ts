import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;

export const API_BASE: string =
  extra.API_BASE ||
  extra.apiBase ||
  extra.apiUrl ||
  process.env.EXPO_PUBLIC_API_BASE ||
  process.env.EXPO_PUBLIC_API_URL ||
  "https://ai-tool-rrau.onrender.com";

function buildUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(buildUrl(path));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body?: any): Promise<T> {
  const res = await fetch(buildUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`);
  }
  return res.json();
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(buildUrl(path), {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`);
  }
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(buildUrl(path), {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DELETE ${path} failed: ${res.status}${text ? ` - ${text}` : ""}`);
  }
  return res.json();
}