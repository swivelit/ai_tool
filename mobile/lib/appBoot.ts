export const APP_BOOT_TIMEOUT_MS = 10000;
export const LOCAL_AGENT_SEED_TIMEOUT_MS = 4000;
export const PROFILE_BOOT_TIMEOUT_MS = 5000;

const SIGNED_OUT_ENTRY_ROUTE = "/auth/login";
const SIGNED_IN_HOME_ROUTE = "/(tabs)";
const TAB_ROUTES = new Set(["/explore", "/routine"]);
const TAB_GROUP_ROOT_ROUTE = "/(tabs)";

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
}) {
  const rawPathname = normalizeRawPathname(input.pathname);
  const pathname = normalizePathname(rawPathname);

  // Expo Router route groups are pathless. At runtime, the `(tabs)` index can
  // report the same pathname (`/`) as the public landing page. The caller can
  // pass `inTabsGroup` from `useSegments()` so the boot guard can distinguish
  // "already on the real tab home" from "stuck on the public root".
  const inTabsGroup = Boolean(input.inTabsGroup);
  const atTabsGroupRoot = rawPathname === TAB_GROUP_ROOT_ROUTE || (inTabsGroup && pathname === "/");
  const atPublicRoot = pathname === "/" && !atTabsGroupRoot;
  const inAuth = pathname === "/auth" || pathname.startsWith("/auth/");
  const inOnboarding = pathname === "/onboarding" || pathname.startsWith("/onboarding/");
  const atProfile = pathname === "/onboarding/profile";
  const atQuestionnaire = pathname === "/onboarding/questionnaire";
  const atSetup = pathname === "/setup";
  const inTabs = atTabsGroupRoot || inTabsGroup || TAB_ROUTES.has(pathname);

  if (!input.hasUser) {
    if (
      pathname === "/" ||
      (pathname === SIGNED_OUT_ENTRY_ROUTE && !atTabsGroupRoot) ||
      inAuth
    ) {
      return null;
    }

    return SIGNED_OUT_ENTRY_ROUTE;
  }

  if (input.profileRestoreFailed) {
    return null;
  }

  if (!input.hasProfile) {
    return atProfile ? null : "/onboarding/profile";
  }

  if (!input.questionnaireCompleted) {
    return atQuestionnaire ? null : "/onboarding/questionnaire";
  }

  if (inAuth || inOnboarding || atPublicRoot) {
    return SIGNED_IN_HOME_ROUTE;
  }

  if (inTabs || atSetup) {
    return null;
  }

  return null;
}