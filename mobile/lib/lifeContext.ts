import AsyncStorage from "@react-native-async-storage/async-storage";

import NativeLifeContext, {
  DailyLifeContext,
  LifeContextPermissionState,
} from "@/modules/life-context";
import { isE2eMockLifeContextEnabled } from "./e2eMode";
import type { LocalAssistantUserProfile } from "./localAssistantProfile";
import type { AssistantSettings } from "./storage";

const CACHE_KEY = "life_context_daily_cache_v1";
const CACHE_MAX_AGE_MS = 2 * 60 * 1000;
const CACHE_UNAVAILABLE_MAX_AGE_MS = 10 * 1000;
const DISTANCE_PER_STEP_METERS = 0.762;

export type LifeContextPermissionSummary = {
  activityRecognition: LifeContextPermissionState;
  usageAccess: LifeContextPermissionState;
};

export type LifeContextAiSummary = {
  enabled: boolean;
  date: string;
  ageGroup?: string;
  shareAppNamesWithAi?: boolean;
  movementSummary?: string;
  screenSummary?: string;
  topAppsSummary?: string;
  lifeInsightSummary?: string;
  raw?: DailyLifeContext;
};

type LifeContextSettings = Pick<
  AssistantSettings,
  "lifeContextEnabled" | "shareLifeContextWithBackend" | "shareAppNamesWithAi"
>;

type LifeContextInput =
  | (Partial<LifeContextSettings> & {
      profile?: LocalAssistantUserProfile | null;
      ageGroup?: string;
      forBackend?: boolean;
      forceRefresh?: boolean;
    })
  | {
      settings?: Partial<LifeContextSettings> | null;
      profile?: LocalAssistantUserProfile | null;
      ageGroup?: string;
      forBackend?: boolean;
      forceRefresh?: boolean;
    };

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function timezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function startOfTodayMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function isValidAgeGroup(value: unknown): value is string {
  return [
    "under_13",
    "13_17",
    "18_25",
    "26_35",
    "36_45",
    "46_60",
    "60_plus",
    "prefer_not_to_say",
  ].includes(String(value || ""));
}

function normalizeAgeGroup(value: unknown): string | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  const normalized = raw.replace(/[–—]/g, "-").replace(/\s+/g, "_");
  const aliases: Record<string, string> = {
    under_13: "under_13",
    "under-13": "under_13",
    "13_17": "13_17",
    "13-17": "13_17",
    "18_25": "18_25",
    "18-25": "18_25",
    "26_35": "26_35",
    "26-35": "26_35",
    "36_45": "36_45",
    "36-45": "36_45",
    "46_60": "46_60",
    "46-60": "46_60",
    "60_plus": "60_plus",
    "60+": "60_plus",
    "60-plus": "60_plus",
    prefer_not_to_say: "prefer_not_to_say",
    "prefer-not-to-say": "prefer_not_to_say",
  };
  return aliases[normalized];
}

function resolveInput(input?: LifeContextInput | null) {
  const record = (input || {}) as Record<string, any>;
  const settings = (record.settings && typeof record.settings === "object"
    ? record.settings
    : record) as Partial<LifeContextSettings>;
  return {
    settings: {
      lifeContextEnabled: settings.lifeContextEnabled === true,
      shareLifeContextWithBackend: settings.shareLifeContextWithBackend === true,
      shareAppNamesWithAi: settings.shareAppNamesWithAi === true,
    },
    profile: (record.profile || null) as LocalAssistantUserProfile | null,
    ageGroup: String(record.ageGroup || "").trim() || undefined,
    forBackend: record.forBackend === true,
    forceRefresh: record.forceRefresh === true,
  };
}

function ageGroupFromInput(input?: LifeContextInput | null) {
  const resolved = resolveInput(input);
  const direct = normalizeAgeGroup(resolved.ageGroup);
  const profileAge = normalizeAgeGroup(resolved.profile?.onboardingAnswers?.age_group);
  const value = isValidAgeGroup(direct)
    ? direct
    : isValidAgeGroup(profileAge)
      ? String(profileAge)
      : undefined;
  return value === "prefer_not_to_say" ? undefined : value;
}

function unavailableContext(): DailyLifeContext {
  const now = new Date();
  return {
    date: todayDate(),
    timezone: timezone(),
    permissions: {
      activityRecognition: "unavailable",
      usageAccess: "unavailable",
    },
    movement: {
      steps: null,
      estimatedDistanceMeters: null,
      confidence: "unavailable",
      source: "native_module_unavailable",
      partialDay: false,
      trackingStartedAtMs: null,
    },
    screen: {
      screenTimeMs: null,
      unlocks: null,
      confidence: "unavailable",
      source: "native_module_unavailable",
    },
    apps: [],
    generatedAt: now.toISOString(),
  };
}

function mockDailyContext(shareAppNamesWithAi: boolean): DailyLifeContext {
  const now = new Date();
  const apps = shareAppNamesWithAi
    ? [
        {
          appName: "ChatGPT",
          category: "productivity",
          foregroundTimeMs: 4_200_000,
          launchCount: 8,
        },
        {
          appName: "YouTube",
          category: "video",
          foregroundTimeMs: 3_600_000,
          launchCount: 5,
        },
        {
          appName: "WhatsApp",
          category: "social",
          foregroundTimeMs: 2_400_000,
          launchCount: 18,
        },
      ]
    : [
        { category: "productivity", foregroundTimeMs: 4_200_000, launchCount: 8 },
        { category: "video", foregroundTimeMs: 3_600_000, launchCount: 5 },
        { category: "social", foregroundTimeMs: 2_400_000, launchCount: 18 },
      ];

  return {
    date: todayDate(),
    timezone: timezone(),
    permissions: {
      activityRecognition: "granted",
      usageAccess: "granted",
    },
    movement: {
      steps: 7420,
      estimatedDistanceMeters: 5650,
      confidence: "high",
      source: "e2e_mock",
      partialDay: false,
      trackingStartedAtMs: null,
    },
    screen: {
      screenTimeMs: 12_600_000,
      unlocks: null,
      confidence: "high",
      source: "e2e_mock",
    },
    apps,
    generatedAt: now.toISOString(),
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatHours(ms: number) {
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(hours >= 10 ? 0 : 1)} hours`;
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minutes`;
}

function movementSummary(context: DailyLifeContext, ageGroup?: string): string | undefined {
  const steps = Number(context.movement.steps);
  if (!Number.isFinite(steps) || steps < 0) return undefined;

  const distanceMeters =
    Number(context.movement.estimatedDistanceMeters) ||
    Math.round(steps * DISTANCE_PER_STEP_METERS);
  const km = distanceMeters / 1000;

  const stepGoals: Record<string, number> = {
    under_13: 12000,
    "13_17": 12000,
    "18_25": 10000,
    "26_35": 10000,
    "36_45": 9000,
    "46_60": 8000,
    "60_plus": 7000,
  };
  const goal = ageGroup && stepGoals[ageGroup] ? stepGoals[ageGroup] : 10000;
  const pct = Math.round((steps / goal) * 100);
  const partialDay = context.movement.partialDay === true;
  const goalNote =
    pct >= 100
      ? `goal achieved (${pct}%!)`
      : pct >= 70
        ? `${pct}% of daily goal`
        : `${pct}% of daily goal - keep it up`;
  const scopedSteps = partialDay
    ? `${formatNumber(Math.round(steps))} steps since tracking started today`
    : `${formatNumber(Math.round(steps))} steps today`;
  const partialNote = partialDay ? ", partial-day estimate" : "";

  return (
    `${scopedSteps} (${goalNote}${partialNote}), ` +
    `~${km.toFixed(1)} km walked (${context.movement.confidence} confidence)`
  );
}

function screenSummary(context: DailyLifeContext, ageGroup?: string): string | undefined {
  const screenTimeMs = Number(context.screen.screenTimeMs);
  if (!Number.isFinite(screenTimeMs) || screenTimeMs < 0) return undefined;

  const hours = screenTimeMs / 3_600_000;

  const warnThresholds: Record<string, number> = {
    under_13: 1,
    "13_17": 2,
    "18_25": 6,
    "26_35": 7,
    "36_45": 6,
    "46_60": 5,
    "60_plus": 4,
  };
  const warnHours = ageGroup && warnThresholds[ageGroup] ? warnThresholds[ageGroup] : 6;

  let rating: string;
  if (hours <= warnHours * 0.5) {
    rating = "healthy";
  } else if (hours <= warnHours) {
    rating = "moderate";
  } else if (hours <= warnHours * 1.5) {
    rating = "high";
  } else {
    rating = "very high";
  }

  const unlockNote =
    Number.isFinite(Number(context.screen.unlocks)) && Number(context.screen.unlocks) > 0
      ? `, ${context.screen.unlocks} phone unlocks`
      : "";

  return (
    `${formatHours(screenTimeMs)} screen time today (${rating}${unlockNote}, ` +
    `${context.screen.confidence} confidence)`
  );
}

function topAppsSummary(
  context: DailyLifeContext,
  shareAppNamesWithAi: boolean,
  ageGroup?: string,
): string | undefined {
  void ageGroup;
  const apps = (context.apps || [])
    .filter((app) => Number(app.foregroundTimeMs) > 0)
    .slice(0, 3);
  if (!apps.length) return undefined;

  const categoryTotals: Record<string, number> = {};
  for (const app of context.apps || []) {
    const category = app.category || "other";
    categoryTotals[category] = (categoryTotals[category] || 0) + Number(app.foregroundTimeMs || 0);
  }
  const dominantCategory = Object.entries(categoryTotals).sort(([, a], [, b]) => b - a)[0]?.[0];
  const dominantNote = dominantCategory ? ` (mostly ${dominantCategory})` : "";

  const appLines = shareAppNamesWithAi
    ? apps.map((app) => `${app.appName || app.category || "app"} ${formatHours(app.foregroundTimeMs)}`)
    : apps.map((app) => `${app.category || "app"} ${formatHours(app.foregroundTimeMs)}`);

  return `Top apps: ${appLines.join(", ")}${dominantNote}`;
}

function lifeInsightSummary(
  context: DailyLifeContext,
  ageGroup?: string,
  shareAppNamesWithAi = false,
): string | undefined {
  const movement = movementSummary(context, ageGroup);
  const screen = screenSummary(context, ageGroup);
  const apps = topAppsSummary(context, shareAppNamesWithAi, ageGroup);
  const parts = [movement, screen, apps].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

export function sanitizeDailyLifeContextForAi(
  context: DailyLifeContext,
  shareAppNamesWithAi: boolean,
): DailyLifeContext {
  return {
    date: String(context.date || todayDate()).slice(0, 32),
    timezone: String(context.timezone || timezone()).slice(0, 80),
    permissions: {
      activityRecognition: String(context.permissions?.activityRecognition || "unavailable"),
      usageAccess: String(context.permissions?.usageAccess || "unavailable"),
    },
    movement: {
      steps: Number.isFinite(Number(context.movement?.steps))
        ? Math.max(0, Math.round(Number(context.movement.steps)))
        : null,
      estimatedDistanceMeters: Number.isFinite(Number(context.movement?.estimatedDistanceMeters))
        ? Math.max(0, Math.round(Number(context.movement.estimatedDistanceMeters)))
        : null,
      confidence: context.movement?.confidence || "unavailable",
      source: String(context.movement?.source || "unknown").slice(0, 80),
      partialDay: context.movement?.partialDay === true,
      trackingStartedAtMs: Number.isFinite(Number(context.movement?.trackingStartedAtMs))
        ? Math.max(0, Math.round(Number(context.movement.trackingStartedAtMs)))
        : null,
      note: context.movement?.note ? String(context.movement.note).slice(0, 180) : undefined,
    },
    screen: {
      screenTimeMs: Number.isFinite(Number(context.screen?.screenTimeMs))
        ? Math.max(0, Math.round(Number(context.screen.screenTimeMs)))
        : null,
      unlocks: Number.isFinite(Number(context.screen?.unlocks))
        ? Math.max(0, Math.round(Number(context.screen.unlocks)))
        : null,
      confidence: context.screen?.confidence || "unavailable",
      source: String(context.screen?.source || "unknown").slice(0, 80),
    },
    apps: (context.apps || [])
      .slice(0, 8)
      .map((app) => ({
        ...(shareAppNamesWithAi && app.packageName
          ? { packageName: String(app.packageName).slice(0, 160) }
          : {}),
        ...(shareAppNamesWithAi && app.appName
          ? { appName: String(app.appName).slice(0, 120) }
          : {}),
        category: app.category ? String(app.category).slice(0, 80) : undefined,
        foregroundTimeMs: Math.max(0, Math.round(Number(app.foregroundTimeMs) || 0)),
        launchCount: Number.isFinite(Number(app.launchCount))
          ? Math.max(0, Math.round(Number(app.launchCount)))
          : undefined,
      }))
      .filter((app) => app.foregroundTimeMs > 0),
    generatedAt: String(context.generatedAt || new Date().toISOString()).slice(0, 40),
  };
}

function hasUnavailableOrDeniedSignals(context: DailyLifeContext) {
  return (
    context.permissions?.activityRecognition !== "granted" ||
    context.permissions?.usageAccess !== "granted" ||
    context.movement?.confidence === "unavailable" ||
    context.screen?.confidence === "unavailable"
  );
}

export async function clearLifeContextCache() {
  await AsyncStorage.removeItem(CACHE_KEY).catch(() => undefined);
}

async function readCachedContext(shareAppNamesWithAi: boolean): Promise<DailyLifeContext | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.date !== todayDate()) return null;
    if (parsed.shareAppNamesWithAi !== shareAppNamesWithAi) return null;
    const generatedAt = Date.parse(String(parsed.generatedAt || ""));
    const context = parsed.context as DailyLifeContext;
    const maxAge = hasUnavailableOrDeniedSignals(context)
      ? CACHE_UNAVAILABLE_MAX_AGE_MS
      : CACHE_MAX_AGE_MS;
    if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > maxAge) {
      return null;
    }
    return context;
  } catch {
    return null;
  }
}

async function writeCachedContext(context: DailyLifeContext, shareAppNamesWithAi: boolean) {
  try {
    await AsyncStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        date: todayDate(),
        shareAppNamesWithAi,
        generatedAt: new Date().toISOString(),
        context,
      }),
    );
  } catch {
    // Life context is optional; cache writes must never break chat.
  }
}

export async function getLifeContextPermissionState(): Promise<LifeContextPermissionSummary> {
  try {
    return await NativeLifeContext.getPermissionState();
  } catch {
    return {
      activityRecognition: "unavailable",
      usageAccess: "unavailable",
    };
  }
}

export async function requestLifeContextPermissions(): Promise<LifeContextPermissionSummary> {
  const activityRecognition = await NativeLifeContext.requestActivityRecognitionPermission().catch(
    () => "unavailable" as LifeContextPermissionState,
  );
  const state = await getLifeContextPermissionState();
  await clearLifeContextCache();
  return {
    ...state,
    activityRecognition,
  };
}

export async function openLifeContextUsageSettings(): Promise<void> {
  await NativeLifeContext.openUsageAccessSettings().catch(() => undefined);
  await clearLifeContextCache();
}

export async function getTodayLifeContextForAi(
  input?: LifeContextInput | null,
): Promise<LifeContextAiSummary> {
  const { settings, forBackend, forceRefresh } = resolveInput(input);
  const ageGroup = ageGroupFromInput(input);
  const date = todayDate();

  if (!settings.lifeContextEnabled) {
    return {
      enabled: false,
      date,
      ...(ageGroup ? { ageGroup } : {}),
    };
  }
  if (forBackend && !settings.shareLifeContextWithBackend) {
    return {
      enabled: false,
      date,
      ...(ageGroup ? { ageGroup } : {}),
    };
  }

  const shareAppNamesWithAi = settings.shareAppNamesWithAi;
  let context: DailyLifeContext | null = null;
  if (isE2eMockLifeContextEnabled()) {
    context = mockDailyContext(shareAppNamesWithAi);
  } else {
    context = forceRefresh ? null : await readCachedContext(shareAppNamesWithAi);
    if (!context) {
      context = await NativeLifeContext.getDailyLifeContext({
        startMs: startOfTodayMs(),
        endMs: Date.now(),
        shareAppNamesWithAi,
      }).catch(() => unavailableContext());
      context = sanitizeDailyLifeContextForAi(context, shareAppNamesWithAi);
      await writeCachedContext(context, shareAppNamesWithAi);
    }
  }

  const sanitized = sanitizeDailyLifeContextForAi(context, shareAppNamesWithAi);
  return {
    enabled: true,
    date: sanitized.date || date,
    ...(ageGroup ? { ageGroup } : {}),
    shareAppNamesWithAi,
    movementSummary: movementSummary(sanitized, ageGroup),
    screenSummary: screenSummary(sanitized, ageGroup),
    topAppsSummary: topAppsSummary(sanitized, shareAppNamesWithAi, ageGroup),
    lifeInsightSummary: lifeInsightSummary(sanitized, ageGroup, shareAppNamesWithAi),
    raw: sanitized,
  };
}
