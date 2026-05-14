export const APP_BOOT_TIMEOUT_MS = 10000;
export const LOCAL_AGENT_SEED_TIMEOUT_MS = 4000;
export const PROFILE_BOOT_TIMEOUT_MS = 5000;
export const GLOBAL_KNOWLEDGE_SYNC_TIMEOUT_MS = 5000;

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

export async function runGlobalKnowledgeSyncBootStep(options: {
  force?: boolean;
  limit?: number;
  logger?: BootLogger;
} = {}) {
  return runBootStep(
    "global knowledge sync",
    async () => {
      const { syncGlobalKnowledge } = await import("./globalKnowledgeSync");
      return syncGlobalKnowledge({ force: options.force, limit: options.limit });
    },
    {
      timeoutMs: GLOBAL_KNOWLEDGE_SYNC_TIMEOUT_MS,
      optional: true,
      logger: options.logger,
    },
  );
}

export async function runGlobalKnowledgeForegroundSyncStep(options: {
  limit?: number;
  logger?: BootLogger;
} = {}) {
  return runBootStep(
    "foreground global knowledge sync",
    async () => {
      const { syncGlobalKnowledgeIfStale } = await import("./globalKnowledgeSync");
      return syncGlobalKnowledgeIfStale({ limit: options.limit });
    },
    {
      timeoutMs: GLOBAL_KNOWLEDGE_SYNC_TIMEOUT_MS,
      optional: true,
      logger: options.logger,
    },
  );
}

export async function runPendingCrashTelemetryBootStep(options: {
  logger?: BootLogger;
} = {}) {
  return runBootStep(
    "pending local turn crash telemetry",
    async () => {
      const { sendPendingCrashMarkerIfPresent } = await import("./chatTelemetry");
      return sendPendingCrashMarkerIfPresent();
    },
    {
      timeoutMs: 3000,
      optional: true,
      logger: options.logger,
    },
  );
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
