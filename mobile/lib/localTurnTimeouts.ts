export const LOCAL_TURN_TIMEOUT_ERROR_CODE = "LOCAL_TURN_TIMEOUT";

export type LocalTurnSource = "text" | "voice" | "handsfree" | string;

export class LocalTurnTimeoutError extends Error {
  readonly code = LOCAL_TURN_TIMEOUT_ERROR_CODE;
  readonly timeoutMs: number;
  readonly source?: string;

  constructor(message: string, options: { timeoutMs: number; source?: string }) {
    super(message);
    this.name = "LocalTurnTimeoutError";
    this.timeoutMs = options.timeoutMs;
    this.source = options.source;
  }
}

export function isLocalTurnTimeoutError(error: unknown) {
  return (
    error instanceof LocalTurnTimeoutError ||
    (error as any)?.code === LOCAL_TURN_TIMEOUT_ERROR_CODE
  );
}

export function getLocalTurnTimeoutMs(input: {
  source?: LocalTurnSource | null;
  selectedTier?: "lite" | "standard" | "pro" | string | null;
} = {}) {
  const source = String(input.source || "text").toLowerCase();
  const selectedTier = String(input.selectedTier || "lite").toLowerCase();

  if (source === "voice") {
    return 90_000;
  }

  if (selectedTier === "pro") {
    return 75_000;
  }

  return 60_000;
}

export function friendlyLocalTimeoutMessage() {
  return "This is taking longer than expected on this phone. Please try again.";
}

export function withLocalTimeout<T>(
  operation: Promise<T> | (() => Promise<T>),
  timeoutMs: number,
  options: {
    message?: string;
    source?: string;
    onTimeout?: () => void | Promise<void>;
  } = {},
): Promise<T> {
  const promise = typeof operation === "function" ? operation() : operation;
  const safeTimeoutMs = Math.max(1, Number(timeoutMs) || 1);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void Promise.resolve(options.onTimeout?.()).catch(() => undefined);
      reject(
        new LocalTurnTimeoutError(
          options.message ||
            `Local on-device inference timed out after ${safeTimeoutMs}ms.`,
          {
            timeoutMs: safeTimeoutMs,
            source: options.source,
          },
        ),
      );
    }, safeTimeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
