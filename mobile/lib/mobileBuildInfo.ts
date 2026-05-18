import Constants from "expo-constants";

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, any>;
const DEFAULT_LOCAL_TO_BACKEND_FALLBACK_MS = 15_000;

function firstNonEmpty(values: unknown[], fallback: string) {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return fallback;
}

function positiveMs(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolFlag(value: unknown) {
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

function isReleaseRuntime() {
  return boolFlag(process.env.EXPO_PUBLIC_RELEASE_BUILD) || boolFlag(extra.RELEASE_BUILD);
}

export function getMobileBuildInfo() {
  const info = {
    mobile_build_id: firstNonEmpty(
      [
        process.env.EXPO_PUBLIC_MOBILE_BUILD_ID,
        extra.EXPO_PUBLIC_MOBILE_BUILD_ID,
        extra.MOBILE_BUILD_ID,
        extra.mobileBuildId,
      ],
      "unknown",
    ),
    mobile_git_sha: firstNonEmpty(
      [
        process.env.EXPO_PUBLIC_GIT_SHA,
        extra.EXPO_PUBLIC_GIT_SHA,
        extra.GIT_SHA,
        extra.gitSha,
      ],
      "unknown",
    ),
    local_to_backend_fallback_ms: positiveMs(
      process.env.EXPO_PUBLIC_LOCAL_TO_BACKEND_FALLBACK_MS ??
        extra.EXPO_PUBLIC_LOCAL_TO_BACKEND_FALLBACK_MS ??
        extra.LOCAL_TO_BACKEND_FALLBACK_MS ??
        extra.localToBackendFallbackMs,
      DEFAULT_LOCAL_TO_BACKEND_FALLBACK_MS,
    ),
    voice_only_mode: boolFlag(
      process.env.EXPO_PUBLIC_VOICE_ONLY_MODE ?? extra.EXPO_PUBLIC_VOICE_ONLY_MODE ?? extra.VOICE_ONLY_MODE,
    ),
  };
  if (isReleaseRuntime() && (info.mobile_build_id === "unknown" || info.mobile_git_sha === "unknown")) {
    throw new Error("Release telemetry requires real mobile build identifiers.");
  }
  return info;
}
