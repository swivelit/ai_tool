import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GlassCard } from "@/components/Glass";
import { Brand } from "@/constants/theme";
import { getCachedDeviceCapabilities } from "@/lib/deviceCapabilities";
import {
  downloadRequiredModels,
  getModelInstallStatus,
} from "@/lib/modelDownloadManager";
import type {
  DeviceCapabilitySnapshot,
  ModelDownloadProgress,
  ModelInstallStatus,
} from "@/lib/modelDownloadManager";

function progressPercent(progress?: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(Number(progress) * 100)));
}

function formatEta(progress: ModelDownloadProgress | null, ready: boolean, busy: boolean) {
  if (ready) return "Ready";
  if (!busy) return "Estimating...";
  if (progress?.phase === "verifying" || progress?.phase === "installed") {
    return "Finalizing setup...";
  }
  const etaSeconds = Number(progress?.etaSeconds);
  if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) {
    return "Estimating...";
  }
  const minutes = Math.max(1, Math.ceil(etaSeconds / 60));
  return `About ${minutes} min left`;
}

function statusCopy(
  status: ModelInstallStatus | null,
  progress: ModelDownloadProgress | null,
  busy: boolean,
  error: string,
) {
  if (error) return "Setup could not finish.";
  if (status?.ready) return "Finalizing setup...";
  if (progress?.phase === "verifying" || progress?.phase === "installed") {
    return "Finalizing setup...";
  }
  if (busy || progress?.phase === "downloading") {
    return "Downloading local AI files...";
  }
  return "Checking this phone...";
}

export default function ModelSetupScreen() {
  const insets = useSafeAreaInsets();
  const [deviceInfo, setDeviceInfo] = useState<DeviceCapabilitySnapshot | null>(null);
  const [status, setStatus] = useState<ModelInstallStatus | null>(null);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const autoStartedRef = useRef(false);
  const autoContinuedRef = useRef(false);

  const percent = progressPercent(
    progress?.totalProgress ?? (status?.ready ? 1 : 0),
  );
  const etaText = useMemo(
    () => formatEta(progress, Boolean(status?.ready), busy),
    [busy, progress, status?.ready],
  );
  const currentStatusText = statusCopy(status, progress, busy, error);

  const loadDeviceInfo = useCallback(async () => {
    if (deviceInfo) return deviceInfo;
    const next = await getCachedDeviceCapabilities();
    setDeviceInfo(next);
    return next;
  }, [deviceInfo]);

  const refreshStatus = useCallback(
    async (snapshot?: DeviceCapabilitySnapshot) => {
      const nextDeviceInfo = snapshot || (await loadDeviceInfo());
      const next = await getModelInstallStatus({ deviceInfo: nextDeviceInfo });
      setStatus(next);
      return next;
    },
    [loadDeviceInfo],
  );

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const snapshot = await getCachedDeviceCapabilities();
        if (cancelled) return;
        setDeviceInfo(snapshot);
        const next = await getModelInstallStatus({ deviceInfo: snapshot });
        if (cancelled) return;
        setStatus(next);
        setError("");
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : "Could not check setup.");
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  const startDownload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const snapshot = await loadDeviceInfo();
      const next = await downloadRequiredModels({
        deviceInfo: snapshot,
        onProgress: setProgress,
      });
      setStatus(next);
      setProgress({
        phase: "installed",
        totalProgress: 1,
        modelProgress: 1,
        etaSeconds: 0,
        message: "Finalizing setup...",
      });
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Model setup failed.";
      setError(message);
      await refreshStatus().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [busy, loadDeviceInfo, refreshStatus]);

  useEffect(() => {
    if (!status || status.ready || busy || autoStartedRef.current) return;
    const needsInstall = status.missing.length > 0 || status.invalid.length > 0;
    if (!needsInstall) return;
    autoStartedRef.current = true;
    setProgress({
      phase: "checking",
      totalModels: status.required.length,
      totalBytes: status.totalRequiredBytes,
      totalProgress: 0,
      modelProgress: 0,
      message: "Checking this phone...",
    });
    void startDownload();
  }, [busy, startDownload, status]);

  useEffect(() => {
    if (!status?.ready || error || autoContinuedRef.current) return;
    autoContinuedRef.current = true;
    const timer = setTimeout(() => router.replace("/(tabs)" as any), 700);
    return () => clearTimeout(timer);
  }, [error, status?.ready]);

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />
      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          paddingTop: insets.top + 18,
          paddingBottom: Math.max(insets.bottom + 24, 24),
          paddingHorizontal: 18,
          flexGrow: 1,
          justifyContent: "center",
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} style={styles.iconButton}>
            <Ionicons name="chevron-back" size={20} color={Brand.cocoa} />
          </Pressable>
        </View>

        <GlassCard style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons
              name={error ? "alert-circle-outline" : status?.ready ? "checkmark-circle-outline" : "phone-portrait-outline"}
              size={26}
              color={error ? Brand.danger : Brand.bronze}
            />
          </View>

          <Text style={styles.title}>Preparing Elli for this phone</Text>
          <Text style={styles.subtitle}>{currentStatusText}</Text>

          <View style={styles.progressHeader}>
            <Text style={styles.progressLabel}>{percent}% complete</Text>
            <Text style={styles.progressLabel}>{etaText}</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${percent}%` }]} />
          </View>

          {!!error && <Text style={styles.errorText}>{error}</Text>}

          <View style={styles.actions}>
            {error ? (
              <Pressable
                onPress={startDownload}
                disabled={busy}
                style={({ pressed }) => [
                  styles.primaryButton,
                  busy && styles.buttonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {busy ? <ActivityIndicator color={Brand.ink} /> : null}
                <Text style={styles.primaryButtonText}>Retry</Text>
              </Pressable>
            ) : null}

            {status?.ready ? (
              <Pressable
                onPress={() => router.replace("/(tabs)" as any)}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryButtonText}>Continue</Text>
              </Pressable>
            ) : null}
          </View>
        </GlassCard>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  headerRow: {
    position: "absolute",
    top: 18,
    left: 18,
    zIndex: 2,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.74)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },
  card: {
    paddingVertical: 28,
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  title: {
    marginTop: 18,
    fontSize: 26,
    lineHeight: 32,
    fontWeight: "900",
    color: Brand.ink,
  },
  subtitle: {
    marginTop: 10,
    fontSize: 15,
    lineHeight: 22,
    color: Brand.muted,
  },
  progressHeader: {
    marginTop: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  progressLabel: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "800",
    color: Brand.cocoa,
  },
  progressTrack: {
    marginTop: 10,
    height: 10,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(124,99,80,0.16)",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: Brand.bronze,
  },
  errorText: {
    marginTop: 16,
    fontSize: 13,
    lineHeight: 20,
    color: Brand.danger,
  },
  actions: {
    marginTop: 20,
    gap: 10,
  },
  primaryButton: {
    minHeight: 52,
    borderRadius: 18,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.bronze,
  },
  primaryButtonText: {
    fontSize: 15,
    fontWeight: "900",
    color: Brand.ink,
  },
  buttonDisabled: { opacity: 0.56 },
  pressed: { opacity: 0.82, transform: [{ scale: 0.995 }] },
});
