import type { ModelDownloadProgress } from "./modelDownloadManager";

export type SetupProgressStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "paused"
  | "reconnecting"
  | "verifying"
  | "installed"
  | "failed";

export function formatProgressPercentLabel(progress: number | null | undefined) {
  const value = Number(progress);
  if (!Number.isFinite(value) || value <= 0) return "0% complete";
  if (value > 0 && value < 0.01) return "<1% complete";
  return `${Math.max(1, Math.min(100, Math.round(value * 100)))}% complete`;
}

export function formatSetupEtaText(options: {
  status?: SetupProgressStatus;
  progress?: Pick<ModelDownloadProgress, "etaSeconds" | "phase"> | null;
  ready?: boolean;
}) {
  if (options.ready) return "Ready";
  if (
    options.status === "verifying" ||
    options.status === "installed" ||
    options.progress?.phase === "verifying" ||
    options.progress?.phase === "installed"
  ) {
    return "Finalizing setup...";
  }
  if (options.status === "paused") return "Paused";
  if (options.status === "reconnecting") {
    return "Waiting for connection. Retrying soon...";
  }

  const etaSeconds = Number(options.progress?.etaSeconds);
  if (!Number.isFinite(etaSeconds) || etaSeconds <= 0 || etaSeconds > 12 * 60 * 60) {
    return "Estimating...";
  }

  const totalMinutes = Math.max(1, Math.ceil(etaSeconds / 60));
  if (totalMinutes < 60) return `About ${totalMinutes} min left`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0
    ? `About ${hours} hr ${minutes} min left`
    : `About ${hours} hr left`;
}

export function setupUserMessageForStatus(status: SetupProgressStatus, ready = false) {
  if (ready || status === "installed" || status === "verifying") {
    return "Finalizing setup...";
  }
  if (status === "paused") return "Paused";
  if (status === "reconnecting") return "Connection interrupted. Retrying automatically...";
  if (status === "downloading") return "Downloading local AI files...";
  if (status === "failed") return "Setup could not finish.";
  return "Checking this phone...";
}

export function isTransientSetupError(error: unknown) {
  if ((error as any)?.transient === true || (error as any)?.name === "ModelDownloadInterruptedError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return [
    /unable to resolve host/i,
    /network request failed/i,
    /HTTP (?:408|429|5\d\d)\b/i,
    /status (?:408|429|5\d\d)\b/i,
    /\btimeout\b/i,
    /timed out/i,
    /ECONNRESET/i,
    /ENETUNREACH/i,
    /EAI_AGAIN/i,
    /connection lost/i,
    /connection (?:was )?interrupted/i,
    /app\/background pause/i,
  ].some((pattern) => pattern.test(message));
}

export function friendlySetupError(error: unknown) {
  const developerError = error instanceof Error ? error.message : String(error ?? "");
  if (isTransientSetupError(error)) {
    return {
      userMessage: "Connection interrupted. Elli will retry automatically. You can also tap Resume.",
      developerError,
      transient: true,
    };
  }
  if (/HTTP (?:401|403|404)\b|signed URL.*expired|forbidden CDN|missing CDN file/i.test(developerError)) {
    return {
      userMessage: "Model download link is unavailable or expired. Check the model CDN setup and try again.",
      developerError,
      transient: false,
    };
  }
  if (/cdn:\/\/ URL|cdn:\/\/ placeholder|unresolved download metadata/i.test(developerError)) {
    return {
      userMessage: "Model download URL is still a cdn:// placeholder. Configure a real public CDN base URL before setup.",
      developerError,
      transient: false,
    };
  }
  if (
    /missing a resolved public\/signed CDN URL|empty downloadUrl|missing model CDN URL/i.test(
      developerError,
    )
  ) {
    return {
      userMessage: "Model download URL is not configured. Add the public model CDN URL and try setup again.",
      developerError,
      transient: false,
    };
  }
  if (/missing expectedBytes|missing byte size|expected byte size/i.test(developerError)) {
    return {
      userMessage: "Model byte-size metadata is missing. Add the expected byte size for this GGUF file and retry.",
      developerError,
      transient: false,
    };
  }
  if (/missing sha256|missing SHA-256|SHA-256 metadata/i.test(developerError)) {
    return {
      userMessage: "Model SHA-256 metadata is missing. Add the release checksum for this GGUF file and retry.",
      developerError,
      transient: false,
    };
  }
  if (
    /JAI_LLAMA_CPP_BACKEND_MISSING|compiled without llama\.cpp|llama\.cpp backend is not available|native on-device inference module/i.test(
      developerError,
    )
  ) {
    return {
      userMessage: "Native AI runtime is unavailable because llama.cpp is not built into this app. Rebuild the app with the native module and GGUF model support.",
      developerError,
      transient: false,
    };
  }
  if (/Required local GGUF models are not ready|reason.*missing|model file.*missing|missing required GGUF/i.test(developerError)) {
    return {
      userMessage: "A required local AI model file is missing. Keep setup open so Elli can download it, then retry.",
      developerError,
      transient: false,
    };
  }
  return {
    userMessage: "Setup could not finish. Check storage and try again.",
    developerError,
    transient: false,
  };
}

export function getWifiWarningMessage(modelSizeBytes?: number) {
  const sizeGb =
    typeof modelSizeBytes === "number"
      ? modelSizeBytes / (1024 * 1024 * 1024)
      : 0;

  if (sizeGb >= 2) {
    return "Large AI model download detected. Wi-Fi is strongly recommended to avoid mobile data charges.";
  }

  if (sizeGb >= 1) {
    return "This setup may use significant mobile data. Wi-Fi is recommended.";
  }

  return "Download ready.";
}

export function getRepairMessage() {
  return "A damaged or incomplete model file was detected and safely removed. Elli will repair it automatically.";
}
export function getModelSetupLayout(dimensions: { width: number; height: number }) {
  const width = Math.max(0, Number(dimensions.width || 0));
  const height = Math.max(0, Number(dimensions.height || 0));
  const compact = width < 380 || height < 700;
  const horizontalPadding = compact ? 14 : 18;
  const cardWidth = Math.max(
    0,
    Math.min(width - horizontalPadding * 2, compact ? 520 : 560),
  );
  return {
    compact,
    horizontalPadding,
    cardWidth,
    cardRadius: compact ? 18 : 24,
    contentPadding: compact ? 16 : 20,
    titleSize: compact ? 22 : 26,
    titleLineHeight: compact ? 27 : 32,
    subtitleSize: compact ? 14 : 15,
    subtitleLineHeight: compact ? 20 : 22,
    iconWrapSize: compact ? 44 : 52,
    iconSize: compact ? 22 : 26,
    buttonMinHeight: compact ? 46 : 52,
    buttonRadius: compact ? 14 : 18,
    stackProgressLabels: width < 340,
  };
}
