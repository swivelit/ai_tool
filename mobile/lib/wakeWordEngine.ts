import { EventEmitter } from "expo-modules-core";
import * as FileSystem from "expo-file-system/legacy";

import { apiFetchRaw, apiGet } from "./api";
import { isE2eMockHandsFreeEnabled } from "./e2eMode";
import type { AssistantSettings, WakeModelSettings, WakeModelStatus } from "./storage";

type NativeWakeWordModule = {
  isAvailable?: () => boolean;
  getStatus?: () => Promise<WakeWordNativeStatus>;
  start?: (config: WakeWordStartConfig) => Promise<{ ok: true }>;
  stop?: () => Promise<{ ok: true }>;
};

export type WakeWordNativeStatus = {
  running: boolean;
  modelLoaded: boolean;
  sampleRate: number;
  frameMs: number;
  lastScore?: number;
  error?: string;
};

export type WakeWordEvent = {
  score: number;
  model: string;
  phraseKey?: string;
  timestamp: number;
};

export type WakeWordStartConfig = {
  phraseKey: string;
  wakePhrase: string;
  modelPaths: {
    wakeModel: string;
    melspectrogramModel?: string;
    embeddingModel?: string;
  };
  threshold?: number;
  sampleRate?: 16000;
  frameMs?: 80;
  minWakeIntervalMs?: number;
};

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
};

type SavedBundle = {
  manifest: any;
  modelPaths: WakeWordStartConfig["modelPaths"];
};

const MODEL_ROOT = `${FileSystem.documentDirectory || ""}wake_word_models`;
const nativeModule: NativeWakeWordModule | null = (() => {
  try {
    return require("../modules/wake-word").default as NativeWakeWordModule;
  } catch {
    return null;
  }
})();

let nativeSubscriptions: Array<{ remove: () => void }> = [];
let e2eWakeTimer: ReturnType<typeof setTimeout> | null = null;

function normalizePhraseKey(value: string) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "wake-phrase"
  );
}

function toWakeModelState(value: WakeModelSettings | null | undefined): WakeModelState {
  const status = value?.status || "missing";
  return {
    ...(value || { status }),
    status,
    ready: status === "ready" || status === "e2e_mock",
  };
}

function statusToState(
  settings: AssistantSettings,
  status: ModelStatusResponse,
  overrides: Partial<WakeModelSettings> = {},
): WakeModelState {
  const nextStatus = (status.ready ? "ready" : status.status || "pending") as WakeModelStatus;
  return toWakeModelState({
    status: nextStatus,
    phraseKey: status.phrase_key || normalizePhraseKey(status.wake_phrase || settings.wakePhrase),
    wakePhrase: status.wake_phrase || settings.wakePhrase,
    modelType: status.model_type,
    threshold: status.threshold,
    sampleRate: status.sample_rate,
    frameMs: status.frame_ms,
    detail: status.detail,
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
    return toWakeModelState(settings.wakeModel);
  }

  const wakePhrase = encodeURIComponent(settings.wakePhrase);
  try {
    const status = await apiGet<ModelStatusResponse>(
      `/api/openwakeword/enrollment/model/status?wake_phrase=${wakePhrase}`,
    );
    if (!status.ready) {
      return statusToState(settings, status);
    }

    const saved = await downloadAndSaveWakeModelBundle(settings.wakePhrase);
    return statusToState(settings, status, {
      status: "ready",
      phraseKey: saved.manifest.phrase_key || status.phrase_key,
      wakePhrase: saved.manifest.wake_phrase || status.wake_phrase || settings.wakePhrase,
      modelType: saved.manifest.model_type || status.model_type,
      threshold: saved.manifest.threshold || status.threshold,
      sampleRate: saved.manifest.sample_rate || status.sample_rate,
      frameMs: saved.manifest.frame_ms || status.frame_ms,
      modelPaths: saved.modelPaths,
    });
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
  const phraseKey = String(manifest.phrase_key || "").trim() || normalizePhraseKey(manifest.wake_phrase || "");
  if (!phraseKey) {
    throw new Error("Wake model manifest is missing phrase_key.");
  }
  if (!FileSystem.documentDirectory) {
    throw new Error("Device storage is unavailable for wake model files.");
  }
  const targetRoot = `${MODEL_ROOT}/${phraseKey}`;
  await FileSystem.makeDirectoryAsync(MODEL_ROOT, { intermediates: true }).catch(() => undefined);
  await FileSystem.deleteAsync(targetRoot, { idempotent: true }).catch(() => undefined);
  await FileSystem.makeDirectoryAsync(targetRoot, { intermediates: true });

  const modelPaths: WakeWordStartConfig["modelPaths"] = { wakeModel: "" };
  const modelFiles = Array.isArray(manifest.model_files) ? manifest.model_files : [];
  for (const entry of modelFiles) {
    const fileName = String(entry.file || "").replace(/^\/+/, "");
    const role = String(entry.role || "").trim();
    const content = entries.get(fileName);
    if (!fileName || !content) {
      throw new Error(`Wake model bundle is missing ${fileName || role || "model file"}.`);
    }
    const uri = `${targetRoot}/${fileName}`;
    await FileSystem.writeAsStringAsync(uri, bytesToBase64(content), {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (role === "wake") modelPaths.wakeModel = uri;
    if (role === "melspectrogram") modelPaths.melspectrogramModel = uri;
    if (role === "embedding") modelPaths.embeddingModel = uri;
  }
  if (!modelPaths.wakeModel) {
    throw new Error("Wake model bundle does not include a wake prediction model.");
  }
  if (!modelPaths.melspectrogramModel || !modelPaths.embeddingModel) {
    throw new Error("Wake model bundle is missing OpenWakeWord mel or embedding artifacts.");
  }
  return { manifest, modelPaths };
}

export async function startWakeWordListening(
  config: WakeWordStartConfig | WakeModelState,
  handlers: {
    onWake: (event: WakeWordEvent) => void;
    onScore?: (event: WakeWordEvent) => void;
    onError?: (error: { code: string; message: string }) => void;
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
  nativeSubscriptions = [
    emitter.addListener("onWake", handlers.onWake),
    emitter.addListener("onWakeError", (payload: any) => {
      handlers.onError?.({
        code: String((payload as any)?.code || "JAI_WAKE_ERROR"),
        message: String((payload as any)?.message || "Wake detection failed."),
      });
    }),
  ];
  if (handlers.onScore) {
    nativeSubscriptions.push(emitter.addListener("onWakeScore", handlers.onScore));
  }
  return nativeModule.start(startConfig);
}

export async function stopWakeWordListening(): Promise<{ ok: true }> {
  if (e2eWakeTimer) {
    clearTimeout(e2eWakeTimer);
    e2eWakeTimer = null;
  }
  nativeSubscriptions.forEach((subscription) => subscription.remove());
  nativeSubscriptions = [];
  if (nativeModule?.stop) {
    await nativeModule.stop().catch(() => undefined);
  }
  return { ok: true };
}

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
