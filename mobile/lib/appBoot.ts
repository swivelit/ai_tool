export const APP_BOOT_TIMEOUT_MS = 10000;
export const LOCAL_AGENT_SEED_TIMEOUT_MS = 4000;
export const PROFILE_BOOT_TIMEOUT_MS = 5000;

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
  if (!pathname || pathname === "/") {
    return "/";
  }

  const trimmed = pathname.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveDesiredRoute(input: {
  pathname?: string | null;
  hasUser: boolean;
  hasProfile: boolean;
  questionnaireCompleted: boolean;
}) {
  const pathname = normalizePathname(input.pathname);
  const atRoot = pathname === "/";
  const inAuth = pathname === "/auth" || pathname.startsWith("/auth/");
  const inOnboarding = pathname === "/onboarding" || pathname.startsWith("/onboarding/");
  const atProfile = pathname === "/onboarding/profile";
  const atQuestionnaire = pathname === "/onboarding/questionnaire";
  const inTabs = pathname === "/(tabs)" || pathname.startsWith("/(tabs)/");
  const atSetup = pathname === "/setup";

  if (!input.hasUser) {
    return atRoot || inAuth ? null : "/";
  }

  if (!input.hasProfile) {
    return atProfile ? null : "/onboarding/profile";
  }

  if (!input.questionnaireCompleted) {
    return atQuestionnaire ? null : "/onboarding/questionnaire";
  }

  if (atRoot || inAuth || inOnboarding) {
    return "/(tabs)";
  }

  if (inTabs || atSetup) {
    return null;
  }

  return null;
}
