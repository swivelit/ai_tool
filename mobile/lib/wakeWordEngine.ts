import { EventEmitter } from "expo-modules-core";
import * as FileSystem from "expo-file-system/legacy";

import { apiFetchRaw, apiGet } from "./api";
import {
  getE2eHandsFreeCommand,
  isE2eMockHandsFreeAudioEnabled,
  isE2eMockHandsFreeEnabled,
} from "./e2eMode";
import type { AssistantSettings, WakeModelSettings, WakeModelStatus } from "./storage";

type NativeWakeWordModule = {
  isAvailable?: () => boolean;
  getStatus?: () => Promise<WakeWordNativeStatus>;
  configure?: (config: WakeWordStartConfig) => Promise<{ ok: true }>;
  startSession?: (config: WakeWordStartConfig) => Promise<{ ok: true }>;
  stopSession?: () => Promise<{ ok: true }>;
  cancelCommand?: () => Promise<{ ok: true }>;
  notifyTtsStarted?: () => Promise<{ ok: true }>;
  notifyTtsCompleted?: () => Promise<{ ok: true }>;
  start?: (config: WakeWordStartConfig) => Promise<{ ok: true }>;
  stop?: () => Promise<{ ok: true }>;
  validateFixturePipeline?: () => Promise<WakeWordFixtureValidation>;
  validateModelBundle?: (config: WakeWordStartConfig) => Promise<WakeWordBundleValidation>;
};

export type WakeWordNativeStatus = {
  running: boolean;
  modelLoaded: boolean;
  sampleRate: number;
  frameMs: number;
  lastScore?: number;
  error?: string;
  sessionState?: HandsFreeNativeState;
  handsFree?: {
    running?: boolean;
    state?: HandsFreeNativeState;
    sampleRate?: number;
    frameMs?: number;
    lastError?: string;
    captureDroppedFrames?: number;
    wakeDroppedFrames?: number;
    vadSpeechFrames?: number;
    vadSkippedWakeFrames?: number;
    vadHangoverFrames?: number;
    vadFailOpenFrames?: number;
    vadRmsThreshold?: number;
    commandPreRollSpeechFrames?: number;
    lastCommandPreRollMs?: number;
    captureThreadAlive?: boolean;
    lastCaptureError?: string;
    lastCaptureErrorCode?: string;
    captureRestartCount?: number;
    captureRestartScheduled?: boolean;
    audioSessionId?: number;
    acousticEchoCancelerEnabled?: boolean;
    noiseSuppressorEnabled?: boolean;
    automaticGainControlEnabled?: boolean;
    inferenceThreadAlive?: boolean;
    lastInferenceError?: string;
    inferenceDroppedFrames?: number;
    inferenceErrorCount?: number;
    fatalErrorCode?: string;
    fatalErrorMessage?: string;
  };
};

export type WakeWordFixtureValidation = {
  ok: boolean;
  deterministicTestSeam?: boolean;
  realOpenWakeWordModelCompatibility?: boolean;
  modelFilesLoaded: boolean;
  shapesAccepted: boolean;
  processFrameRan: boolean;
  wakeEmitted: boolean;
  score?: number;
  model?: string;
  phraseKey?: string;
};

export type WakeWordBundleValidation = {
  ok: boolean;
  available?: boolean;
  status?: string;
  detail?: string;
  deterministicTestSeam?: boolean;
  realOpenWakeWordModelCompatibility?: boolean;
  modelFilesExist?: boolean;
  manifestRolesPresent?: boolean;
  startConfigModelPathsPresent?: boolean;
  modelShapesAccepted?: boolean;
  model?: string;
  phraseKey?: string;
};

export type WakeWordEvent = {
  score: number;
  model: string;
  phraseKey?: string;
  timestamp: number;
};

export type HandsFreeNativeState =
  | "idle"
  | "wakeListening"
  | "wakeDetected"
  | "commandListening"
  | "commandReady"
  | "submitting"
  | "speaking";

export type HandsFreeStateEvent = {
  state: HandsFreeNativeState;
  previousState?: HandsFreeNativeState;
  reason?: string;
  timestamp?: number;
};

export type HandsFreeCommandEvent = {
  text?: string;
  empty?: boolean;
  reason?: string;
  timestamp?: number;
};

export type HandsFreeCommandAudioEvent = {
  uri?: string;
  fileUri?: string;
  durationMs: number;
  sampleRate: number;
  mimeType: "audio/wav" | string;
  timestamp?: number;
};

export type WakeWordNativeError = {
  code: string;
  message: string;
  permanent?: boolean;
  restartable?: boolean;
  sessionActive?: boolean;
  source?: "capture" | "inference" | "session" | "model" | string;
  timestamp?: number;
};

export type WakeWordStartConfig = {
  phraseKey: string;
  wakePhrase: string;
  modelPaths: {
    wakeModel: string;
    melspectrogramModel?: string;
    embeddingModel?: string;
  };
  manifestRoles?: string[];
  threshold?: number;
  vadRmsThreshold?: number;
  vadThreshold?: number;
  sampleRate?: 16000;
  frameMs?: 80;
  minWakeIntervalMs?: number;
};

const E2E_HANDS_FREE_WAV_BASE64 =
  "UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

export type WakeModelState = WakeModelSettings & {
  ready: boolean;
};

type ModelStatusResponse = {
  ok?: boolean;
  ready?: boolean;
  status?: WakeModelStatus | string;
  phrase_key?: string;
  wake_phrase?: string;
  model_type?: string;
  threshold?: number;
  sample_rate?: number;
  frame_ms?: number;
  detail?: string;
  model_files?: Array<{
    role?: string;
    file?: string;
  }>;
};

type SavedBundle = {
  manifest: any;
  modelPaths: WakeWordStartConfig["modelPaths"];
  modelRoles: string[];
};

const MODEL_ROOT = `${FileSystem.documentDirectory || ""}wake_word_models`;
const REQUIRED_MODEL_ROLES = ["wake", "melspectrogram", "embedding"] as const;
const MODEL_FILE_ROLES = new Set<string>(REQUIRED_MODEL_ROLES);
const nativeModule: NativeWakeWordModule | null = (() => {
  if (process.env.NODE_ENV === "test") {
    const testOverride = (globalThis as any).__JAI_WAKE_WORD_NATIVE_MODULE_FOR_TESTS__;
    if (testOverride) return testOverride as NativeWakeWordModule;
  }
  try {
    return require("../modules/wake-word").default as NativeWakeWordModule;
  } catch {
    return null;
  }
})();

let wakeSubscriptions: Array<{ remove: () => void }> = [];
let sessionSubscriptions: Array<{ remove: () => void }> = [];
let e2eWakeTimer: ReturnType<typeof setTimeout> | null = null;
let e2eSessionTimers: Array<ReturnType<typeof setTimeout>> = [];

function normalizePhraseKey(value: string) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "wake-phrase"
  );
}

function validateSafePhraseKey(value: unknown) {
  const phraseKey = String(value || "").trim();
  if (
    !phraseKey ||
    phraseKey === "." ||
    phraseKey === ".." ||
    phraseKey.length > 64 ||
    !/^[A-Za-z0-9_-]+$/.test(phraseKey)
  ) {
    throw new Error("Wake model manifest has an unsafe phrase_key.");
  }
  return phraseKey;
}

function toWakeModelState(value: WakeModelSettings | null | undefined): WakeModelState {
  const status = value?.status || "missing";
  return {
    ...(value || { status }),
    status,
    ready: status === "ready" || status === "e2e_mock",
  };
}

export function wakeModelStateFromApiStatus(
  settings: AssistantSettings,
  status: ModelStatusResponse,
  overrides: Partial<WakeModelSettings> = {},
): WakeModelState {
  const nextStatus = (status.ready ? "ready" : status.status || "pending") as WakeModelStatus;
  const modelRoles = Array.isArray(status.model_files)
    ? Array.from(
        new Set(
          status.model_files
            .map((entry) => String(entry?.role || "").trim())
            .filter(Boolean)
        )
      )
    : undefined;
  return toWakeModelState({
    status: nextStatus,
    phraseKey: status.phrase_key || normalizePhraseKey(status.wake_phrase || settings.wakePhrase),
    wakePhrase: status.wake_phrase || settings.wakePhrase,
    modelType: status.model_type,
    threshold: status.threshold,
    sampleRate: status.sample_rate,
    frameMs: status.frame_ms,
    detail: status.detail,
    modelRoles,
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

export function isWakeWordAvailable() {
  if (isE2eMockHandsFreeEnabled()) return true;
  try {
    return Boolean(nativeModule?.isAvailable?.());
  } catch {
    return false;
  }
}

export async function getWakeWordStatus(): Promise<WakeWordNativeStatus> {
  if (!nativeModule?.getStatus) {
    return {
      running: false,
      modelLoaded: false,
      sampleRate: 16000,
      frameMs: 80,
      error: "JaiWakeWord native module is unavailable.",
    };
  }
  return nativeModule.getStatus();
}

export async function validateNativeWakeWordFixture(): Promise<WakeWordFixtureValidation> {
  if (!nativeModule?.validateFixturePipeline) {
    return {
      ok: false,
      deterministicTestSeam: true,
      realOpenWakeWordModelCompatibility: false,
      modelFilesLoaded: false,
      shapesAccepted: false,
      processFrameRan: false,
      wakeEmitted: false,
    };
  }
  return nativeModule.validateFixturePipeline();
}

export function validateWakeModelBundleConfig(
  config: WakeWordStartConfig | WakeModelState,
): WakeWordBundleValidation {
  const startConfig = normalizeStartConfig(config);
  const requiredRoles = ["wake", "melspectrogram", "embedding"];
  const roles = new Set((startConfig.manifestRoles || []).map((role) => String(role || "").trim()));
  const missingRoles = requiredRoles.filter((role) => !roles.has(role));
  const startConfigModelPathsPresent = Boolean(
    startConfig.modelPaths.wakeModel &&
      startConfig.modelPaths.melspectrogramModel &&
      startConfig.modelPaths.embeddingModel,
  );
  if (missingRoles.length > 0) {
    return {
      ok: false,
      status: "unsupported",
      detail: "Wake model manifest must include wake, melspectrogram, and embedding roles.",
      deterministicTestSeam: false,
      realOpenWakeWordModelCompatibility: false,
      manifestRolesPresent: false,
      startConfigModelPathsPresent,
    };
  }
  if (!startConfigModelPathsPresent) {
    return {
      ok: false,
      status: "unsupported",
      detail: "Wake model bundle is missing wake, melspectrogram, or embedding model paths.",
      deterministicTestSeam: false,
      realOpenWakeWordModelCompatibility: false,
      manifestRolesPresent: true,
      startConfigModelPathsPresent: false,
    };
  }
  return {
    ok: true,
    deterministicTestSeam: false,
    realOpenWakeWordModelCompatibility: false,
    manifestRolesPresent: true,
    startConfigModelPathsPresent: true,
    model: startConfig.modelPaths.wakeModel.split("/").pop(),
    phraseKey: startConfig.phraseKey,
  };
}

export async function validateNativeWakeModelBundle(
  config: WakeWordStartConfig | WakeModelState,
): Promise<WakeWordBundleValidation> {
  const localValidation = validateWakeModelBundleConfig(config);
  if (!localValidation.ok) return localValidation;
  if (!nativeModule?.validateModelBundle) {
    return {
      ...localValidation,
      ok: false,
      available: false,
      status: "unavailable",
      detail: "JaiWakeWord native model-bundle validation is unavailable.",
    };
  }
  if (!isWakeWordAvailable()) {
    return {
      ...localValidation,
      ok: false,
      available: false,
      status: "unsupported",
      detail: "Native wake-word detection is unavailable.",
    };
  }
  try {
    return await nativeModule.validateModelBundle(normalizeStartConfig(config));
  } catch (error) {
    return {
      ...localValidation,
      ok: false,
      available: true,
      status: nativeValidationFailureStatus(error),
      detail: conciseWakeModelDetail(
        error instanceof Error ? error.message : String(error || ""),
        "Wake model bundle failed native validation.",
      ),
    };
  }
}

async function fileExists(path?: string) {
  if (!path) return false;
  const normalized = path.startsWith("file://") ? path : `file://${path}`;
  const info = await FileSystem.getInfoAsync(normalized);
  return Boolean(info.exists && !info.isDirectory);
}

async function readyModelExists(value: WakeModelSettings | null | undefined) {
  if (!value || value.status !== "ready") return false;
  const paths = value.modelPaths || {};
  return (
    (await fileExists(paths.wakeModel)) &&
    (await fileExists(paths.melspectrogramModel)) &&
    (await fileExists(paths.embeddingModel))
  );
}

function wakeModelStateFromNativeValidationFailure(
  settings: AssistantSettings,
  validation: WakeWordBundleValidation,
): WakeModelState {
  const status = validation.status === "error" ? "error" : "unsupported";
  return toWakeModelState({
    status,
    wakePhrase: settings.wakePhrase,
    modelType: settings.wakeModel?.modelType,
    detail: conciseWakeModelDetail(validation.detail, "Needs model"),
    updatedAt: new Date().toISOString(),
  });
}

function nativeValidationFailureStatus(error: unknown): WakeModelStatus {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("unsupported") ||
    normalized.includes("unavailable") ||
    normalized.includes("not found") ||
    normalized.includes("missing") ||
    normalized.includes("permission") ||
    normalized.includes("model")
  ) {
    return "unsupported";
  }
  return "error";
}

function conciseWakeModelDetail(value: unknown, fallback: string) {
  const raw = String(value || "").trim();
  const cleaned = raw
    .replace(/^JaiWakeWord error \[[^\]]+\]:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 220);
}

function validateBundleManifestFiles(
  modelFiles: Array<{ role?: unknown; file?: unknown; bytes?: unknown; sha256?: unknown }>,
  entries: Map<string, Uint8Array>,
) {
  const byRole = new Map<
    string,
    { role: "wake" | "melspectrogram" | "embedding"; file: string; content: Uint8Array }
  >();

  for (const entry of modelFiles) {
    const role = String(entry?.role || "").trim();
    if (!MODEL_FILE_ROLES.has(role)) {
      throw new Error("Wake model manifest roles must be wake, melspectrogram, or embedding.");
    }
    const file = validateSafeModelFileName(entry?.file, role);
    if (byRole.has(role)) {
      throw new Error(`Wake model manifest contains duplicate ${role} entries.`);
    }
    const content = entries.get(file);
    if (!content) {
      throw new Error(`Wake model bundle is missing ${file}.`);
    }

    const expectedBytes = entry?.bytes;
    if (typeof expectedBytes === "undefined" || expectedBytes === null) {
      throw new Error(`Wake model manifest is missing byte length for ${file}.`);
    }
    const byteCount = Number(expectedBytes);
    if (!Number.isInteger(byteCount) || byteCount < 0) {
      throw new Error(`Wake model manifest has invalid byte length for ${file}.`);
    }
    if (content.length !== byteCount) {
      throw new Error(`Wake model bundle byte length mismatch for ${file}.`);
    }

    if (typeof entry?.sha256 === "undefined" || entry?.sha256 === null || String(entry.sha256).trim() === "") {
      throw new Error(`Wake model manifest is missing SHA-256 for ${file}.`);
    }
    const expectedSha = normalizeSha(entry.sha256);
    if (sha256Bytes(content) !== expectedSha) {
      throw new Error(`Wake model bundle SHA-256 mismatch for ${file}.`);
    }

    byRole.set(role, { role: role as "wake" | "melspectrogram" | "embedding", file, content });
  }

  const missingRoles = REQUIRED_MODEL_ROLES.filter((role) => !byRole.has(role));
  if (missingRoles.length > 0) {
    throw new Error("Wake model manifest must include wake, melspectrogram, and embedding roles.");
  }

  return REQUIRED_MODEL_ROLES.map((role) => byRole.get(role)!);
}

function validateSafeModelFileName(value: unknown, role: string) {
  const file = String(value || "").trim();
  const unsafe =
    !file ||
    file.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(file) ||
    file.includes("/") ||
    file.includes("\\") ||
    file.split(/[\\/]/).includes("..") ||
    file === "." ||
    file === "..";
  if (unsafe) {
    throw new Error(`Wake model manifest has an unsafe file path for ${role || "model"}.`);
  }
  if (!file.toLowerCase().endsWith(".onnx")) {
    throw new Error(`Wake model manifest role ${role || "model"} must point to an ONNX file.`);
  }
  return file;
}

function normalizeSha(value: unknown) {
  const sha = String(value || "").trim().toLowerCase();
  if (!sha) return "";
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error("Wake model manifest has invalid SHA-256 metadata.");
  }
  return sha;
}

export async function ensureWakeModel(settings: AssistantSettings): Promise<WakeModelState> {
  if (isE2eMockHandsFreeEnabled()) {
    return toWakeModelState({
      status: "e2e_mock",
      phraseKey: "e2e-mock",
      wakePhrase: settings.wakePhrase,
      modelType: "e2e_mock",
      threshold: 0.5,
      sampleRate: 16000,
      frameMs: 80,
      modelRoles: ["wake", "melspectrogram", "embedding"],
      updatedAt: new Date().toISOString(),
    });
  }

  if (!isWakeWordAvailable()) {
    return toWakeModelState({
      status: "unsupported",
      wakePhrase: settings.wakePhrase,
      detail: "Needs model",
      updatedAt: new Date().toISOString(),
    });
  }

  if (settings.wakeModel?.status === "ready" && (await readyModelExists(settings.wakeModel))) {
    const cachedModel = toWakeModelState(settings.wakeModel);
    const cachedValidation = await validateNativeWakeModelBundle(cachedModel);
    if (cachedValidation.ok && cachedValidation.realOpenWakeWordModelCompatibility === true) {
      return cachedModel;
    }
    return wakeModelStateFromNativeValidationFailure(settings, cachedValidation);
  }

  const wakePhrase = encodeURIComponent(settings.wakePhrase);
  try {
    const status = await apiGet<ModelStatusResponse>(
      `/api/openwakeword/enrollment/model/status?wake_phrase=${wakePhrase}`,
    );
    if (!status.ready) {
      return wakeModelStateFromApiStatus(settings, status);
    }

    const saved = await downloadAndSaveWakeModelBundle(settings.wakePhrase);
    const prepared = wakeModelStateFromApiStatus(settings, status, {
      status: "ready",
      phraseKey: saved.manifest.phrase_key || status.phrase_key,
      wakePhrase: saved.manifest.wake_phrase || status.wake_phrase || settings.wakePhrase,
      modelType: saved.manifest.model_type || status.model_type,
      threshold: saved.manifest.threshold || status.threshold,
      sampleRate: saved.manifest.sample_rate || status.sample_rate,
      frameMs: saved.manifest.frame_ms || status.frame_ms,
      modelPaths: saved.modelPaths,
      modelRoles: saved.modelRoles,
    });
    const validation = await validateNativeWakeModelBundle(prepared);
    if (!validation.ok || validation.realOpenWakeWordModelCompatibility !== true) {
      return wakeModelStateFromNativeValidationFailure(settings, validation);
    }
    return prepared;
  } catch (error) {
    return toWakeModelState({
      status: "error",
      wakePhrase: settings.wakePhrase,
      detail: error instanceof Error ? error.message : "Could not prepare wake model.",
      updatedAt: new Date().toISOString(),
    });
  }
}

export async function downloadAndSaveWakeModelBundle(wakePhrase: string): Promise<SavedBundle> {
  const response = await apiFetchRaw(
    `/api/openwakeword/enrollment/model/download?wake_phrase=${encodeURIComponent(wakePhrase)}`,
    { method: "GET" },
    { timeoutMs: 60_000 },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Wake model download failed: ${response.status}${text ? ` - ${text}` : ""}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return saveWakeModelBundleBytes(bytes);
}

export async function saveWakeModelBundleBytes(bytes: Uint8Array): Promise<SavedBundle> {
  const entries = parseStoredZip(bytes);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) {
    throw new Error("Wake model bundle is missing manifest.json.");
  }
  const manifest = JSON.parse(bytesToUtf8(manifestBytes));
  const hasManifestPhraseKey = Object.prototype.hasOwnProperty.call(manifest, "phrase_key");
  const phraseKey = validateSafePhraseKey(
    hasManifestPhraseKey ? manifest.phrase_key : normalizePhraseKey(manifest.wake_phrase || ""),
  );
  if (!FileSystem.documentDirectory) {
    throw new Error("Device storage is unavailable for wake model files.");
  }

  const modelFiles: Array<{ role?: unknown; file?: unknown; bytes?: unknown; sha256?: unknown }> = Array.isArray(manifest.model_files)
    ? manifest.model_files
    : [];
  const validatedFiles = validateBundleManifestFiles(modelFiles, entries);
  const modelPaths: WakeWordStartConfig["modelPaths"] = { wakeModel: "" };
  const modelRoles = validatedFiles.map((entry) => entry.role);
  const targetRoot = `${MODEL_ROOT}/${phraseKey}`;
  await FileSystem.makeDirectoryAsync(MODEL_ROOT, { intermediates: true }).catch(() => undefined);
  await FileSystem.deleteAsync(targetRoot, { idempotent: true }).catch(() => undefined);
  await FileSystem.makeDirectoryAsync(targetRoot, { intermediates: true });

  for (const entry of validatedFiles) {
    const uri = `${targetRoot}/${entry.file}`;
    await FileSystem.writeAsStringAsync(uri, bytesToBase64(entry.content), {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (entry.role === "wake") modelPaths.wakeModel = uri;
    if (entry.role === "melspectrogram") modelPaths.melspectrogramModel = uri;
    if (entry.role === "embedding") modelPaths.embeddingModel = uri;
  }
  if (!modelPaths.wakeModel) {
    throw new Error("Wake model bundle does not include a wake prediction model.");
  }
  if (!modelPaths.melspectrogramModel || !modelPaths.embeddingModel) {
    throw new Error("Wake model bundle is missing OpenWakeWord mel or embedding artifacts.");
  }
  return { manifest, modelPaths, modelRoles };
}

export async function startWakeWordListening(
  config: WakeWordStartConfig | WakeModelState,
  handlers: {
    onWake: (event: WakeWordEvent) => void;
    onScore?: (event: WakeWordEvent) => void;
    onError?: (error: WakeWordNativeError) => void;
  },
): Promise<{ ok: true }> {
  await stopWakeWordListening();

  const startConfig = normalizeStartConfig(config);
  if (isE2eMockHandsFreeEnabled()) {
    e2eWakeTimer = setTimeout(() => {
      handlers.onWake({
        score: 1,
        model: "e2e_mock",
        phraseKey: startConfig.phraseKey,
        timestamp: Date.now(),
      });
    }, 250);
    return { ok: true };
  }

  if (!nativeModule?.start) {
    throw new Error("JaiWakeWord native module is unavailable.");
  }
  if (!isWakeWordAvailable()) {
    throw new Error("Native wake-word detection is unavailable.");
  }
  const emitter = new EventEmitter(nativeModule as any) as any;
  wakeSubscriptions = [
    emitter.addListener("onWake", handlers.onWake),
    emitter.addListener("onWakeError", (payload: any) => {
      handlers.onError?.(normalizeWakeWordNativeError(payload));
    }),
  ];
  if (handlers.onScore) {
    wakeSubscriptions.push(emitter.addListener("onWakeScore", handlers.onScore));
  }
  try {
    return await nativeModule.start(startConfig);
  } catch (error) {
    wakeSubscriptions.forEach((subscription) => subscription.remove());
    wakeSubscriptions = [];
    throw error;
  }
}

export async function stopWakeWordListening(): Promise<{ ok: true }> {
  if (e2eWakeTimer) {
    clearTimeout(e2eWakeTimer);
    e2eWakeTimer = null;
  }
  wakeSubscriptions.forEach((subscription) => subscription.remove());
  wakeSubscriptions = [];
  if (nativeModule?.stop) {
    await nativeModule.stop().catch(() => undefined);
  }
  return { ok: true };
}

export async function configureHandsFreeSession(
  config: WakeWordStartConfig | WakeModelState,
): Promise<{ ok: true }> {
  const startConfig = normalizeStartConfig(config);
  if (isE2eMockHandsFreeEnabled()) return { ok: true };
  if (!nativeModule?.configure) {
    throw new Error("JaiWakeWord native session API is unavailable.");
  }
  return nativeModule.configure(startConfig);
}

export async function createE2eHandsFreeCommandAudioEvent(): Promise<HandsFreeCommandAudioEvent> {
  const root = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!root) {
    throw new Error("Expo file system cache is unavailable for E2E hands-free audio.");
  }
  const fileUri = `${root.replace(/\/?$/, "/")}e2e-handsfree-command-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(fileUri, E2E_HANDS_FREE_WAV_BASE64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return {
    uri: fileUri,
    fileUri,
    durationMs: 1000,
    sampleRate: 16000,
    mimeType: "audio/wav",
    timestamp: Date.now(),
  };
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeWakeWordNativeError(payload: any): WakeWordNativeError {
  return {
    code: String(payload?.code || "JAI_WAKE_ERROR"),
    message: String(payload?.message || "Wake detection failed."),
    permanent: optionalBoolean(payload?.permanent),
    restartable: optionalBoolean(payload?.restartable),
    sessionActive: optionalBoolean(payload?.sessionActive),
    source: payload?.source ? String(payload.source) : undefined,
    timestamp: payload?.timestamp ? Number(payload.timestamp) : undefined,
  };
}

export async function startHandsFreeSession(
  config: WakeWordStartConfig | WakeModelState,
  handlers: {
    onState?: (event: HandsFreeStateEvent) => void;
    onWake?: (event: WakeWordEvent) => void;
    onScore?: (event: WakeWordEvent) => void;
    onCommand?: (event: HandsFreeCommandEvent) => void;
    onCommandAudio?: (event: HandsFreeCommandAudioEvent) => void;
    onError?: (error: WakeWordNativeError) => void;
  },
): Promise<{ ok: true }> {
  await stopHandsFreeSession();

  const startConfig = normalizeStartConfig(config);
  if (isE2eMockHandsFreeEnabled()) {
    const command = getE2eHandsFreeCommand() || "tell me about Spitzola";
    const emitCommandAudio = isE2eMockHandsFreeAudioEnabled();
    e2eSessionTimers = [
      setTimeout(() => {
        handlers.onState?.({
          state: "wakeListening",
          previousState: "idle",
          reason: "e2e_session_started",
          timestamp: Date.now(),
        });
      }, 25),
      setTimeout(() => {
        handlers.onState?.({
          state: "wakeDetected",
          previousState: "wakeListening",
          reason: "e2e_wake_detected",
          timestamp: Date.now(),
        });
        handlers.onWake?.({
          score: 1,
          model: "e2e_mock",
          phraseKey: startConfig.phraseKey,
          timestamp: Date.now(),
        });
      }, 250),
      setTimeout(() => {
        handlers.onState?.({
          state: "commandListening",
          previousState: "wakeDetected",
          reason: "e2e_command_listening",
          timestamp: Date.now(),
        });
      }, 300),
      setTimeout(() => {
        handlers.onState?.({
          state: "commandReady",
          previousState: "commandListening",
          reason: "e2e_command_ready",
          timestamp: Date.now(),
        });
        if (emitCommandAudio) {
          void createE2eHandsFreeCommandAudioEvent().then((event) => {
            console.info("[e2e_hands_free_audio_mock] onCommandAudio", {
              fileUri: event.fileUri,
              mimeType: event.mimeType,
              durationMs: event.durationMs,
              sampleRate: event.sampleRate,
              client_source: "handsfree",
            });
            handlers.onCommandAudio?.(event);
          });
        } else {
          handlers.onCommand?.({
            text: command,
            empty: false,
            reason: "e2e_mock",
            timestamp: Date.now(),
          });
        }
      }, 450),
    ];
    return { ok: true };
  }

  if (!nativeModule?.startSession) {
    throw new Error("JaiWakeWord native session API is unavailable.");
  }
  if (!isWakeWordAvailable()) {
    throw new Error("Native wake-word detection is unavailable.");
  }

  const emitter = new EventEmitter(nativeModule as any) as any;
  sessionSubscriptions = [
    emitter.addListener("onState", (payload: any) => {
      handlers.onState?.({
        state: String(payload?.state || "idle") as HandsFreeNativeState,
        previousState: payload?.previousState
          ? (String(payload.previousState) as HandsFreeNativeState)
          : undefined,
        reason: payload?.reason ? String(payload.reason) : undefined,
        timestamp: Number(payload?.timestamp || Date.now()),
      });
    }),
    emitter.addListener("onWake", (payload: any) => {
      handlers.onWake?.({
        score: Number(payload?.score || 0),
        model: String(payload?.model || ""),
        phraseKey: payload?.phraseKey ? String(payload.phraseKey) : undefined,
        timestamp: Number(payload?.timestamp || Date.now()),
      });
    }),
    emitter.addListener("onWakeError", (payload: any) => {
      handlers.onError?.(normalizeWakeWordNativeError(payload));
    }),
    emitter.addListener("onCommand", (payload: any) => {
      handlers.onCommand?.({
        text: payload?.text ? String(payload.text) : "",
        empty: Boolean(payload?.empty),
        reason: payload?.reason ? String(payload.reason) : undefined,
        timestamp: Number(payload?.timestamp || Date.now()),
      });
    }),
    emitter.addListener("onCommandAudio", (payload: any) => {
      const fileUri = String(payload?.fileUri || payload?.uri || "");
      handlers.onCommandAudio?.({
        uri: fileUri,
        fileUri,
        durationMs: Number(payload?.durationMs || 0),
        sampleRate: Number(payload?.sampleRate || 16000),
        mimeType: String(payload?.mimeType || "audio/wav"),
        timestamp: Number(payload?.timestamp || Date.now()),
      });
    }),
  ];
  if (handlers.onScore) {
    sessionSubscriptions.push(emitter.addListener("onWakeScore", handlers.onScore));
  }

  try {
    return await nativeModule.startSession(startConfig);
  } catch (error) {
    sessionSubscriptions.forEach((subscription) => subscription.remove());
    sessionSubscriptions = [];
    throw error;
  }
}

export async function stopHandsFreeSession(): Promise<{ ok: true }> {
  e2eSessionTimers.forEach((timer) => clearTimeout(timer));
  e2eSessionTimers = [];
  sessionSubscriptions.forEach((subscription) => subscription.remove());
  sessionSubscriptions = [];
  if (nativeModule?.stopSession) {
    await nativeModule.stopSession().catch(() => undefined);
  }
  return { ok: true };
}

export async function cancelHandsFreeCommand(): Promise<{ ok: true }> {
  if (nativeModule?.cancelCommand) {
    await nativeModule.cancelCommand().catch(() => undefined);
  }
  return { ok: true };
}

export async function notifyHandsFreeTtsStarted(): Promise<{ ok: true }> {
  if (nativeModule?.notifyTtsStarted) {
    await nativeModule.notifyTtsStarted().catch(() => undefined);
  }
  return { ok: true };
}

export async function notifyHandsFreeTtsCompleted(): Promise<{ ok: true }> {
  if (nativeModule?.notifyTtsCompleted) {
    await nativeModule.notifyTtsCompleted().catch(() => undefined);
  }
  return { ok: true };
}

export const configureWakeWordSession = configureHandsFreeSession;
export const startWakeWordSession = startHandsFreeSession;
export const stopWakeWordSession = stopHandsFreeSession;
export const cancelWakeWordCommand = cancelHandsFreeCommand;
export const notifyWakeWordTtsStarted = notifyHandsFreeTtsStarted;
export const notifyWakeWordTtsCompleted = notifyHandsFreeTtsCompleted;
export const configure = configureHandsFreeSession;
export const startSession = startHandsFreeSession;
export const stopSession = stopHandsFreeSession;

function normalizeStartConfig(config: WakeWordStartConfig | WakeModelState): WakeWordStartConfig {
  const maybeState = config as WakeModelState;
  if ("status" in maybeState) {
    if (!maybeState.ready && maybeState.status !== "e2e_mock") {
      throw new Error("Wake model is not ready.");
    }
    const rawModelPaths = maybeState.modelPaths || {};
    const wakeModel = rawModelPaths.wakeModel || "";
    if (!wakeModel && maybeState.status !== "e2e_mock") {
      throw new Error("Wake model path is missing.");
    }
    if (
      maybeState.status !== "e2e_mock" &&
      (!rawModelPaths.melspectrogramModel || !rawModelPaths.embeddingModel)
    ) {
      throw new Error("Wake model bundle is missing OpenWakeWord mel or embedding artifacts.");
    }
    return {
      phraseKey: maybeState.phraseKey || normalizePhraseKey(maybeState.wakePhrase || ""),
      wakePhrase: maybeState.wakePhrase || "",
      modelPaths: {
        wakeModel,
        melspectrogramModel: rawModelPaths.melspectrogramModel,
        embeddingModel: rawModelPaths.embeddingModel,
      },
      manifestRoles: maybeState.modelRoles,
      threshold: maybeState.threshold,
      sampleRate: 16000,
      frameMs: 80,
      minWakeIntervalMs: 1800,
    };
  }
  return config as WakeWordStartConfig;
}

function readUint16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function parseStoredZip(bytes: Uint8Array) {
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 30 <= bytes.length && readUint32(bytes, offset) === 0x04034b50) {
    const flags = readUint16(bytes, offset + 6);
    const method = readUint16(bytes, offset + 8);
    const compressedSize = readUint32(bytes, offset + 18);
    const fileNameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const fileName = bytesToUtf8(bytes.slice(nameStart, nameStart + fileNameLength));

    if (flags & 0x08) {
      throw new Error("Wake model ZIP uses data descriptors, which are not supported.");
    }
    if (method !== 0) {
      throw new Error("Wake model ZIP must use stored entries.");
    }
    if (dataEnd > bytes.length) {
      throw new Error("Wake model ZIP entry is truncated.");
    }
    if (fileName && !fileName.endsWith("/")) {
      entries.set(fileName, bytes.slice(dataStart, dataEnd));
    }
    offset = dataEnd;
  }
  return entries;
}

function bytesToUtf8(bytes: Uint8Array) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }
  let output = "";
  bytes.forEach((byte) => {
    output += String.fromCharCode(byte);
  });
  return decodeURIComponent(escape(output));
}

function rotr(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256Bytes(bytes: Uint8Array) {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const w = new Array<number>(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[index] + w[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triplet = (a << 16) | (b << 8) | c;
    output += alphabet[(triplet >> 18) & 63];
    output += alphabet[(triplet >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(triplet >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[triplet & 63] : "=";
  }
  return output;
}
