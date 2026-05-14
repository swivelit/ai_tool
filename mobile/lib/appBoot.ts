export const APP_BOOT_TIMEOUT_MS = 10000;
export const LOCAL_AGENT_SEED_TIMEOUT_MS = 4000;
export const PROFILE_BOOT_TIMEOUT_MS = 5000;
 
 
export type BootPhase =
  | "auth_restore"
  | "profile_restore"
  | "model_readiness"
  | "ui_ready";
 
export const BOOT_PHASE_ORDER: readonly BootPhase[] = [
  "auth_restore",
  "profile_restore",
  "model_readiness",
  "ui_ready",
] as const;
 
export const BOOT_PHASE_LABELS: Record<BootPhase, string> = {
  auth_restore: "Restoring session…",
  profile_restore: "Loading profile…",
  model_readiness: "Checking model…",
  ui_ready: "Ready",
};
 
export type BootPhaseRecord = {
  phase: BootPhase;
  startMs: number;
  endMs: number | null;
  status: "pending" | "completed" | "failed" | "timed_out";
};
 
export type BootTimeline = {
  createdAtMs: number;
  phases: Map<BootPhase, BootPhaseRecord>;
};
 
export function createBootTimeline(): BootTimeline {
  return {
    createdAtMs: Date.now(),
    phases: new Map(),
  };
}
 
export function recordBootPhase(
  timeline: BootTimeline,
  phase: BootPhase,
  status: BootPhaseRecord["status"],
): void {
  const now = Date.now();
  const existing = timeline.phases.get(phase);
 
  if (!existing) {
    timeline.phases.set(phase, {
      phase,
      startMs: now,
      endMs: status === "pending" ? null : now,
      status,
    });
    return;
  }
 
  if (status !== "pending") {
    timeline.phases.set(phase, {
      ...existing,
      endMs: now,
      status,
    });
  }
}
 
export function getBootSummary(timeline: BootTimeline) {
  const totalMs = Date.now() - timeline.createdAtMs;
  const phases: {
    phase: BootPhase;
    durationMs: number | null;
    status: string;
  }[] = [];
 
  for (const phase of BOOT_PHASE_ORDER) {
    const record = timeline.phases.get(phase);
    if (!record) {
      phases.push({ phase, durationMs: null, status: "skipped" });
      continue;
    }
 
    phases.push({
      phase,
      durationMs:
        record.endMs != null ? record.endMs - record.startMs : null,
      status: record.status,
    });
  }
 
  return { totalMs, phases };
}
 
export type PerfLogCategory =
  | "boot"
  | "chat_first_token"
  | "chat_final"
  | "stt"
  | "tts"
  | "model_setup"
  | "device"
  | "guard";
 
export function perfLog(
  category: PerfLogCategory,
  label: string,
  durationMs?: number | null,
  meta?: Record<string, unknown>,
) {
  const parts = [`[perf:${category}] ${label}`];
 
  if (durationMs != null) {
    parts.push(`${Math.round(durationMs)}ms`);
  }
 
  if (meta) {
    try {
      parts.push(JSON.stringify(meta));
    } catch {
      // ignore serialization failures
    }
  }
 
  console.info(parts.join(" | "));
}
 
export function emitBootPerfLog(timeline: BootTimeline) {
  const summary = getBootSummary(timeline);
  const phaseDetails = summary.phases
    .map(
      (p) =>
        `${p.phase}=${p.status}${p.durationMs != null ? `(${p.durationMs}ms)` : ""}`,
    )
    .join(", ");
 
  perfLog("boot", `total=${summary.totalMs}ms`, summary.totalMs, {
    phases: phaseDetails,
  });
}
 
export function getCurrentBootPhase(flags: {
  authLoading: boolean;
  profileLoading: boolean;
  modelStatusLoading: boolean;
}): BootPhase {
  if (flags.authLoading) return "auth_restore";
  if (flags.profileLoading) return "profile_restore";
  if (flags.modelStatusLoading) return "model_readiness";
  return "ui_ready";
}
 
const SIGNED_OUT_ENTRY_ROUTE = "/auth/login";
const SIGNED_IN_HOME_ROUTE = "/(chat)";
const TAB_ROUTES = new Set(["/explore", "/routine"]);
const TAB_GROUP_ROOT_ROUTE = "/(tabs)";
const CHAT_GROUP_ROOT_ROUTE = "/(chat)";
 
type BootLogger = (message: string, error?: unknown) => void;
 
export type BootStepResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "timed_out" };
 
type RunBootStepOptions = {
  timeoutMs: number;
  optional?: boolean;
  logger?: BootLogger;
};
 
function defaultBootLogger(message: string, error?: unknown) {
  if (typeof error === "undefined") {
    console.warn(message);
    return;
  }
 
  console.warn(message, error);
}
 
export async function runBootStep<T>(
  stepName: string,
  task: () => Promise<T>,
  options: RunBootStepOptions
): Promise<BootStepResult<T>> {
  const { timeoutMs, optional = false, logger = defaultBootLogger } = options;
 
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
 
  const timeout = new Promise<BootStepResult<T>>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      logger(
        `[boot] ${stepName} timed out after ${timeoutMs}ms${
          optional ? "; continuing without blocking app." : "."
        }`
      );
      resolve({ status: "timed_out" });
    }, timeoutMs);
  });
 
  const execution = (async () => {
    try {
      const value = await task();
 
      if (timedOut) {
        logger(`[boot] ${stepName} completed after timeout; ignoring late result.`);
        return { status: "timed_out" } as BootStepResult<T>;
      }
 
      return { status: "completed", value } as BootStepResult<T>;
    } catch (error) {
      logger(
        `[boot] ${stepName} failed${optional ? "; continuing without blocking app." : "."}`,
        error
      );
      return { status: "failed", error } as BootStepResult<T>;
    }
  })();
 
  const result = await Promise.race([execution, timeout]);
 
  if (timer) {
    clearTimeout(timer);
  }
 
  return result;
}
 
export function getPendingBootSteps(flags: {
  authLoading: boolean;
  profileLoading: boolean;
  localSeedLoading: boolean;
}) {
  const pending: string[] = [];
 
  if (flags.authLoading) {
    pending.push("auth state");
  }
 
  if (flags.profileLoading) {
    pending.push("assistant profile");
  }
 
  if (flags.localSeedLoading) {
    pending.push("local agent seed data");
  }
 
  return pending;
}
 
export function normalizePathname(pathname?: string | null) {
  if (!pathname) {
    return "/";
  }
 
  const trimmed = pathname.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
 
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
 
  if (normalized.startsWith("/(tabs)/")) {
    const stripped = normalized.replace("/(tabs)", "");
    return stripped || "/";
  }
 
  if (normalized.startsWith("/(chat)/")) {
    const stripped = normalized.replace("/(chat)", "");
    return stripped || "/";
  }
 
  return normalized;
}
 
function normalizeRawPathname(pathname?: string | null) {
  if (!pathname) {
    return "/";
  }
 
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
 
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
 
export function resolveDesiredRoute(input: {
  pathname?: string | null;
  hasUser: boolean;
  hasProfile: boolean;
  questionnaireCompleted: boolean;
  profileRestoreFailed?: boolean;
  inTabsGroup?: boolean;
  inChatGroup?: boolean;
  modelSetupRequired?: boolean;
}) {
  const rawPathname = normalizeRawPathname(input.pathname);
  const pathname = normalizePathname(rawPathname);
 
  // Expo Router route groups are pathless. At runtime, a group index can
  // report the same pathname (`/`) as the public landing page. The caller can
  // pass group state from `useSegments()` so the boot guard can distinguish
  // "already on the real app home" from "stuck on the public root".
  const inTabsGroup = Boolean(input.inTabsGroup);
  const inChatGroup = Boolean(input.inChatGroup);
  const atTabsGroupRoot = rawPathname === TAB_GROUP_ROOT_ROUTE || (inTabsGroup && pathname === "/");
  const atChatGroupRoot = rawPathname === CHAT_GROUP_ROOT_ROUTE || (inChatGroup && pathname === "/");
  const atPublicRoot = pathname === "/" && !atTabsGroupRoot && !atChatGroupRoot;
  const inAuth = pathname === "/auth" || pathname.startsWith("/auth/");
  const inOnboarding = pathname === "/onboarding" || pathname.startsWith("/onboarding/");
  const atProfile = pathname === "/onboarding/profile";
  const atQuestionnaire = pathname === "/onboarding/questionnaire";
  const atSetup = pathname === "/setup";
  const atModelSetup = pathname === "/model-setup";
  const inTabs = atTabsGroupRoot || inTabsGroup || TAB_ROUTES.has(pathname);
 
  if (!input.hasUser) {
    if (
      (pathname === "/" && !atTabsGroupRoot && !atChatGroupRoot) ||
      (pathname === SIGNED_OUT_ENTRY_ROUTE && !atTabsGroupRoot) ||
      inAuth
    ) {
      return null;
    }
 
    return SIGNED_OUT_ENTRY_ROUTE;
  }
 
  if (!input.hasProfile) {
    return atProfile ? null : "/onboarding/profile";
  }
 
  if (!input.questionnaireCompleted) {
    return atQuestionnaire ? null : "/onboarding/questionnaire";
  }
 
  if (input.modelSetupRequired) {
    return atModelSetup ? null : "/model-setup";
  }
 
  if (inAuth || inOnboarding || atPublicRoot || atModelSetup) {
    return SIGNED_IN_HOME_ROUTE;
  }
 
  if (atChatGroupRoot || inChatGroup || inTabs || atSetup) {
    return null;
  }
 
  return null;
}
 
 
 
