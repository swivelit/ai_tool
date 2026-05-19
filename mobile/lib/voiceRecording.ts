import * as FileSystem from "expo-file-system/legacy";

export const RECORDING_START_TIMEOUT_MS = 10_000;
export const MIN_VOICE_RECORDING_MS = 900;
export const MIC_START_TIMEOUT_MESSAGE =
  "Microphone did not start. Please try again.";
export const EMPTY_AUDIO_MESSAGE = "I could not capture audio. Please try again.";
export const TOO_SHORT_AUDIO_MESSAGE =
  "I could not capture enough speech. Hold the mic until Recording appears, then speak for at least a second.";

export class RecordingStartTimeoutError extends Error {
  constructor() {
    super(MIC_START_TIMEOUT_MESSAGE);
    this.name = "RecordingStartTimeoutError";
  }
}

export class RecordingStartCancelledError extends Error {
  constructor() {
    super("Recording startup cancelled.");
    this.name = "RecordingStartCancelledError";
  }
}

export class VoiceRecordingTooShortError extends Error {
  constructor() {
    super(TOO_SHORT_AUDIO_MESSAGE);
    this.name = "VoiceRecordingTooShortError";
  }
}

export function withRecordingStartTimeout<T>(
  operation: Promise<T>,
  timeoutMs = RECORDING_START_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RecordingStartTimeoutError());
    }, timeoutMs);

    operation.then(
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

export function assertMinimumVoiceRecordingDuration(
  durationMs?: number | null,
  minimumMs = MIN_VOICE_RECORDING_MS,
) {
  if (
    durationMs === null ||
    typeof durationMs === "undefined" ||
    !Number.isFinite(durationMs) ||
    !Number.isFinite(minimumMs) ||
    durationMs < minimumMs
  ) {
    throw new VoiceRecordingTooShortError();
  }
  return durationMs;
}

export async function assertUsableAudioFile(
  uri: string,
  fileSystem: Pick<typeof FileSystem, "getInfoAsync"> = FileSystem,
) {
  const fileInfo = await fileSystem.getInfoAsync(uri);
  if (!fileInfo.exists || Number((fileInfo as any).size || 0) <= 0) {
    throw new Error(EMPTY_AUDIO_MESSAGE);
  }
  return fileInfo;
}
