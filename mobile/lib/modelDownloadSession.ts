import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  downloadRequiredModels,
  errorMessage,
  isTransientModelDownloadError,
  ModelDownloadInterruptedError,
} from "./modelDownloadManager";
import type {
  EnsureModelsOptions,
  ModelDownloadHandle,
  ModelDownloadProgress,
  ModelDownloadResumableStore,
  ModelDownloadResumeState,
  ModelInstallStatus,
} from "./modelDownloadManager";
import {
  friendlySetupError,
  setupUserMessageForStatus,
  type SetupProgressStatus,
} from "./setupProgressCopy";

type AsyncStorageLike = Pick<
  typeof AsyncStorage,
  "getItem" | "setItem" | "removeItem"
>;

export type ModelDownloadSessionSnapshot = {
  status: SetupProgressStatus;
  progress: ModelDownloadProgress | null;
  userMessage: string;
  developerError: string | null;
  canRetry: boolean;
  ready: boolean;
  installStatus: ModelInstallStatus | null;
  reconnectAttempt: number;
  nextRetryAtMs: number | null;
};

export type ModelDownloadSessionListener = (
  snapshot: ModelDownloadSessionSnapshot,
) => void;

type SessionDeps = {
  storage?: AsyncStorageLike;
};

const STORAGE_KEY_PREFIX = "elli:model-download-session:v1:";
const RECONNECT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000] as const;

function storageKey(state: ModelDownloadResumeState) {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(
    `${state.selectedTier || "default"}:${state.modelId}:${state.fileName}`,
  )}`;
}

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function stateMatches(
  stored: ModelDownloadResumeState | null,
  expected: ModelDownloadResumeState,
) {
  return Boolean(
    stored &&
      stored.modelId === expected.modelId &&
      stored.fileName === expected.fileName &&
      stored.targetUri === expected.targetUri &&
      stored.tempUri === expected.tempUri &&
      stored.downloadUrl === expected.downloadUrl,
  );
}

function savableFromDownload(download: ModelDownloadHandle | null) {
  if (typeof download?.savable !== "function") return null;
  try {
    const savable = download.savable();
    return savable && typeof savable === "object" ? savable : null;
  } catch {
    return null;
  }
}

function resumeDataFrom(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const resumeData = (value as { resumeData?: unknown }).resumeData;
  return typeof resumeData === "string" && resumeData.length > 0
    ? resumeData
    : null;
}

function statusFromProgress(progress: ModelDownloadProgress): SetupProgressStatus {
  if (progress.phase === "skipped") return "installed";
  if (progress.phase === "checking") return "checking";
  if (progress.phase === "downloading") return "downloading";
  if (progress.phase === "paused") return "paused";
  if (progress.phase === "reconnecting") return "reconnecting";
  if (progress.phase === "verifying") return "verifying";
  if (progress.phase === "installed") return "installed";
  return "failed";
}

function initialSnapshot(): ModelDownloadSessionSnapshot {
  return {
    status: "idle",
    progress: null,
    userMessage: setupUserMessageForStatus("idle"),
    developerError: null,
    canRetry: false,
    ready: false,
    installStatus: null,
    reconnectAttempt: 0,
    nextRetryAtMs: null,
  };
}

export class ModelDownloadSession {
  private readonly storage: AsyncStorageLike;
  private readonly listeners = new Set<ModelDownloadSessionListener>();
  private snapshot = initialSnapshot();
  private activePromise: Promise<ModelDownloadSessionSnapshot> | null = null;
  private activeDownload: ModelDownloadHandle | null = null;
  private activeResumeState: ModelDownloadResumeState | null = null;
  private lastOptions: EnsureModelsOptions = {};
  private pauseRequested = false;
  private pauseReason: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private nextRetryAtMs: number | null = null;

  constructor(deps: SessionDeps = {}) {
    this.storage = deps.storage || AsyncStorage;
  }

  subscribe(listener: ModelDownloadSessionListener) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot() {
    return this.snapshot;
  }

  start(options: EnsureModelsOptions = {}) {
    if (this.activePromise) return this.activePromise;
    if (this.snapshot.ready) return Promise.resolve(this.snapshot);

    this.clearReconnectTimer({ resetAttempt: true });
    this.lastOptions = { ...options };
    this.pauseRequested = false;
    this.pauseReason = null;

    return this.startRun(this.lastOptions);
  }

  retry() {
    if (this.snapshot.status === "paused" || this.snapshot.status === "reconnecting") {
      return this.resume();
    }
    return this.start(this.lastOptions);
  }

  resume() {
    if (this.activePromise) return this.activePromise;
    if (this.snapshot.ready) return Promise.resolve(this.snapshot);
    this.clearReconnectTimer({ resetAttempt: true });
    this.pauseRequested = false;
    this.pauseReason = null;
    return this.startRun(this.lastOptions);
  }

  async pause(reason = "manual") {
    this.pauseRequested = true;
    this.pauseReason = reason;
    this.clearReconnectTimer({ resetAttempt: true });
    await this.persistActiveState();

    const download = this.activeDownload;
    if (typeof download?.pauseAsync === "function") {
      try {
        const paused = await download.pauseAsync();
        await this.persistActiveState(paused);
      } catch (error) {
        await this.persistActiveState();
        this.logDeveloperError(error);
      }
    }

    this.setSnapshot({
      status: "paused",
      userMessage: "Paused",
      developerError: this.snapshot.developerError,
      canRetry: true,
      ready: false,
      reconnectAttempt: 0,
      nextRetryAtMs: null,
    });
  }

  private startRun(options: EnsureModelsOptions) {
    const run = this.run(options);
    this.activePromise = run;
    run.finally(() => {
      if (this.activePromise === run) {
        this.activePromise = null;
      }
    });
    return run;
  }

  private async run(options: EnsureModelsOptions) {
    this.setSnapshot({
      status: "checking",
      userMessage: setupUserMessageForStatus("checking"),
      developerError: null,
      canRetry: false,
      ready: false,
      nextRetryAtMs: null,
    });

    try {
      const status = await downloadRequiredModels({
        ...options,
        onProgress: (progress) => {
          options.onProgress?.(progress);
          const nextStatus = statusFromProgress(progress);
          this.setSnapshot({
            status: nextStatus,
            progress,
            userMessage: setupUserMessageForStatus(nextStatus),
            developerError: null,
            canRetry: nextStatus === "paused" || nextStatus === "reconnecting",
            ready: false,
          });
        },
        resumableStore: this.createResumeStore(options.resumableStore),
        onDownloadCreated: (download, state) => {
          this.activeDownload = download;
          this.activeResumeState = state;
          options.onDownloadCreated?.(download, state);
        },
        onDownloadSettled: (download, state) => {
          if (this.activeDownload === download) {
            this.activeDownload = null;
            this.activeResumeState = null;
          }
          options.onDownloadSettled?.(download, state);
        },
        isPauseRequested: () => this.pauseRequested || Boolean(options.isPauseRequested?.()),
      });

      this.setSnapshot({
        status: "installed",
        progress: {
          phase: "installed",
          totalProgress: 1,
          modelProgress: 1,
          etaSeconds: 0,
          message: "Finalizing setup...",
        },
        userMessage: "Finalizing setup...",
        developerError: null,
        canRetry: false,
        ready: status.ready,
        installStatus: status,
        reconnectAttempt: 0,
        nextRetryAtMs: null,
      });
    } catch (error) {
      const interrupted = error instanceof ModelDownloadInterruptedError;
      const transient =
        interrupted ||
        this.pauseRequested ||
        isTransientModelDownloadError(error);
      const safeError = friendlySetupError(error);
      this.logDeveloperError(error);

      const nextStatus: SetupProgressStatus =
        this.pauseRequested || this.pauseReason
          ? "paused"
          : transient
            ? "reconnecting"
            : "failed";
      this.setSnapshot({
        status: nextStatus,
        userMessage: nextStatus === "paused" ? "Paused" : safeError.userMessage,
        developerError: safeError.developerError || errorMessage(error),
        canRetry: true,
        ready: false,
      });
    }

    return this.snapshot;
  }

  private createResumeStore(extraStore?: ModelDownloadResumableStore): ModelDownloadResumableStore {
    return {
      load: async (expected) => {
        const raw = await this.storage.getItem(storageKey(expected)).catch(() => null);
        const stored = safeJsonParse<ModelDownloadResumeState>(raw);
        const value = stateMatches(stored, expected) ? stored : null;
        return (await extraStore?.load?.(expected)) || value;
      },
      save: async (state) => {
        await this.storage.setItem(storageKey(state), JSON.stringify(state));
        await extraStore?.save?.(state);
      },
      remove: async (state) => {
        await this.storage.removeItem(storageKey(state));
        await extraStore?.remove?.(state);
      },
    };
  }

  private async persistActiveState(pauseResult?: unknown) {
    if (!this.activeResumeState) return;
    const savable = savableFromDownload(this.activeDownload) || (
      pauseResult && typeof pauseResult === "object"
        ? (pauseResult as Record<string, unknown>)
        : null
    );
    const nextState: ModelDownloadResumeState = {
      ...this.activeResumeState,
      savable,
      resumeData:
        resumeDataFrom(pauseResult) ||
        resumeDataFrom(savable) ||
        this.activeResumeState.resumeData ||
        null,
      updatedAt: Date.now(),
    };
    this.activeResumeState = nextState;
    await this.storage.setItem(storageKey(nextState), JSON.stringify(nextState)).catch(() => undefined);
  }

  private reconnectDelayMsForAttempt(attempt: number) {
    const index = Math.max(0, Math.min(RECONNECT_BACKOFF_MS.length - 1, attempt - 1));
    return RECONNECT_BACKOFF_MS[index];
  }

  private ensureReconnectRetryScheduled() {
    if (this.reconnectTimer) {
      return {
        reconnectAttempt: this.reconnectAttempt,
        nextRetryAtMs: this.nextRetryAtMs,
      };
    }

    this.reconnectAttempt += 1;
    const delayMs = this.reconnectDelayMsForAttempt(this.reconnectAttempt);
    this.nextRetryAtMs = Date.now() + delayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextRetryAtMs = null;
      void this.runScheduledReconnectRetry();
    }, delayMs);

    return {
      reconnectAttempt: this.reconnectAttempt,
      nextRetryAtMs: this.nextRetryAtMs,
    };
  }

  private clearReconnectTimer(options: { resetAttempt?: boolean } = {}) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = null;
    this.nextRetryAtMs = null;
    if (options.resetAttempt) {
      this.reconnectAttempt = 0;
    }
  }

  private runScheduledReconnectRetry() {
    if (
      this.activePromise ||
      this.snapshot.ready ||
      this.snapshot.status !== "reconnecting" ||
      this.pauseRequested ||
      this.pauseReason
    ) {
      this.setSnapshot({
        nextRetryAtMs: null,
        canRetry: this.snapshot.status === "reconnecting" && !this.snapshot.ready,
      });
      return this.activePromise || Promise.resolve(this.snapshot);
    }

    this.pauseRequested = false;
    this.pauseReason = null;
    this.setSnapshot({
      canRetry: false,
      nextRetryAtMs: null,
    });
    return this.startRun(this.lastOptions);
  }

  private setSnapshot(patch: Partial<ModelDownloadSessionSnapshot>) {
    const nextPatch: Partial<ModelDownloadSessionSnapshot> = { ...patch };

    if (nextPatch.status === "reconnecting") {
      const scheduled = this.ensureReconnectRetryScheduled();
      nextPatch.reconnectAttempt = scheduled.reconnectAttempt;
      nextPatch.nextRetryAtMs = scheduled.nextRetryAtMs;
      nextPatch.canRetry = true;
    } else if (nextPatch.status) {
      const shouldResetAttempt =
        nextPatch.status === "paused" ||
        nextPatch.status === "installed" ||
        nextPatch.status === "failed" ||
        nextPatch.status === "idle";
      this.clearReconnectTimer({ resetAttempt: shouldResetAttempt });
      nextPatch.nextRetryAtMs = null;
      nextPatch.reconnectAttempt = this.reconnectAttempt;
    }

    this.snapshot = {
      ...this.snapshot,
      ...nextPatch,
    };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private logDeveloperError(error: unknown) {
    if (Boolean((globalThis as any).__DEV__)) {
      console.warn("[modelDownloadSession]", error);
    }
  }
}

let singleton = new ModelDownloadSession();

export const modelDownloadSession = {
  start: (options?: EnsureModelsOptions) => singleton.start(options),
  retry: () => singleton.retry(),
  pause: (reason?: string) => singleton.pause(reason),
  resume: () => singleton.resume(),
  subscribe: (listener: ModelDownloadSessionListener) => singleton.subscribe(listener),
  getSnapshot: () => singleton.getSnapshot(),
};

export function createModelDownloadSession(deps: SessionDeps = {}) {
  return new ModelDownloadSession(deps);
}

export function resetModelDownloadSessionForTests(deps: SessionDeps = {}) {
  singleton = new ModelDownloadSession(deps);
  return singleton;
}
