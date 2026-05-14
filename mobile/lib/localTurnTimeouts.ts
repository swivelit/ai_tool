export const LOCAL_TURN_TIMEOUT_ERROR_CODE = "LOCAL_TURN_TIMEOUT";

export type LocalTurnSource = "text" | "voice" | "handsfree" | string;

export type LocalTurnTimeoutDeviceInfo = {
  lowPowerMode?: boolean | null;
  lowMemory?: boolean | null;
  lowRamDevice?: boolean | null;
  batteryLevel?: number | null;
  thermalState?: string | null;
  availableMemoryBytes?: number | null;
  preferredTier?: "lite" | "standard" | "pro" | string | null;
};

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
  preferredTier?: "lite" | "standard" | "pro" | string | null;
  deviceInfo?: LocalTurnTimeoutDeviceInfo | null;
} = {}) {
  const source = String(input.source || "text").toLowerCase();
  const deviceInfo = input.deviceInfo || {};
  const selectedTier = String(
    input.selectedTier ||
      input.preferredTier ||
      deviceInfo.preferredTier ||
      "lite",
  ).toLowerCase();

  const isVoiceLike = source === "voice" || source === "handsfree";
  let timeoutMs = isVoiceLike
    ? selectedTier === "pro"
      ? 120_000
      : selectedTier === "standard"
        ? 105_000
        : 90_000
    : selectedTier === "pro"
      ? 150_000
      : selectedTier === "standard"
        ? 120_000
        : 90_000;

  if (deviceInfo.lowRamDevice) timeoutMs += isVoiceLike ? 15_000 : 10_000;
  if (deviceInfo.lowMemory) timeoutMs += isVoiceLike ? 15_000 : 10_000;
  if (deviceInfo.lowPowerMode) timeoutMs += 5_000;

  const batteryLevel = Number(deviceInfo.batteryLevel);
  if (Number.isFinite(batteryLevel) && batteryLevel > 0 && batteryLevel <= 0.2) {
    timeoutMs += 5_000;
  }

  const thermalState = String(deviceInfo.thermalState || "").toLowerCase();
  if (/(serious|critical|severe|fair|warning|hot)/.test(thermalState)) {
    timeoutMs += isVoiceLike ? 15_000 : 10_000;
  }

  const availableMemoryBytes = Number(deviceInfo.availableMemoryBytes);
  if (Number.isFinite(availableMemoryBytes) && availableMemoryBytes > 0) {
    if (availableMemoryBytes < 1_000_000_000) {
      timeoutMs += isVoiceLike ? 15_000 : 10_000;
    } else if (availableMemoryBytes < 2_000_000_000) {
      timeoutMs += 5_000;
    }
  }

  return Math.min(Math.max(timeoutMs, 90_000), 150_000);
}

export function getLocalTurnSoftNoticeMs(input: {
  source?: LocalTurnSource | null;
  selectedTier?: "lite" | "standard" | "pro" | string | null;
  preferredTier?: "lite" | "standard" | "pro" | string | null;
  deviceInfo?: LocalTurnTimeoutDeviceInfo | null;
} = {}) {
  const source = String(input.source || "text").toLowerCase();
  const isVoiceLike = source === "voice" || source === "handsfree";
  const deviceInfo = input.deviceInfo || {};
  let noticeMs = isVoiceLike ? 20_000 : 18_000;

  if (deviceInfo.lowRamDevice || deviceInfo.lowMemory) {
    noticeMs = Math.min(noticeMs, 16_000);
  }

  return Math.min(Math.max(noticeMs, 15_000), 20_000);
}

export function friendlyLocalTimeoutMessage() {
  return "This is taking longer than expected on this phone. Please try again, or open model setup to check the local AI files.";
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
