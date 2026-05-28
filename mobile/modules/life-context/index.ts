import { requireNativeModule } from "expo-modules-core";

export type LifeContextPermissionState = "granted" | "denied" | "unavailable";

export type DailyLifeContext = {
  date: string;
  timezone: string;
  permissions: {
    activityRecognition: LifeContextPermissionState | string;
    usageAccess: LifeContextPermissionState | string;
  };
  movement: {
    steps: number | null;
    estimatedDistanceMeters: number | null;
    confidence: "high" | "medium" | "low" | "unavailable";
    source: string;
  };
  screen: {
    screenTimeMs: number | null;
    unlocks?: number | null;
    confidence: "high" | "medium" | "low" | "unavailable";
    source: string;
  };
  apps: Array<{
    packageName?: string;
    appName?: string;
    category?: string;
    foregroundTimeMs: number;
    launchCount?: number;
  }>;
  generatedAt: string;
};

export type LifeContextNativeModule = {
  getPermissionState(): Promise<{
    activityRecognition: LifeContextPermissionState;
    usageAccess: LifeContextPermissionState;
  }>;
  requestActivityRecognitionPermission(): Promise<LifeContextPermissionState>;
  openUsageAccessSettings(): Promise<void>;
  getDailyLifeContext(input?: {
    startMs?: number;
    endMs?: number;
    shareAppNamesWithAi?: boolean;
  }): Promise<DailyLifeContext>;
};

function unavailableContext(): DailyLifeContext {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    date: now.toISOString().slice(0, 10),
    timezone,
    permissions: {
      activityRecognition: "unavailable",
      usageAccess: "unavailable",
    },
    movement: {
      steps: null,
      estimatedDistanceMeters: null,
      confidence: "unavailable",
      source: "native_module_unavailable",
    },
    screen: {
      screenTimeMs: null,
      unlocks: null,
      confidence: "unavailable",
      source: "native_module_unavailable",
    },
    apps: [],
    generatedAt: now.toISOString(),
  };
}

const fallbackModule: LifeContextNativeModule = {
  async getPermissionState() {
    return {
      activityRecognition: "unavailable",
      usageAccess: "unavailable",
    };
  },
  async requestActivityRecognitionPermission() {
    return "unavailable";
  },
  async openUsageAccessSettings() {
    return undefined;
  },
  async getDailyLifeContext() {
    return unavailableContext();
  },
};

let nativeModule: LifeContextNativeModule | null = null;

try {
  nativeModule = requireNativeModule("LifeContext") as LifeContextNativeModule;
} catch {
  nativeModule = null;
}

export default nativeModule || fallbackModule;
