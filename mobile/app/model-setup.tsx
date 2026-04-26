import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  ModelDownloadProgress,
  ModelInstallStatus,
  downloadRequiredModels,
  getModelInstallStatus,
} from "@/lib/modelDownloadManager";

function formatBytes(value?: number | null) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let current = bytes;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function progressPercent(progress?: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(Number(progress) * 100)));
}

export default function ModelSetupScreen() {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<ModelInstallStatus | null>(null);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const missingCount = (status?.missing.length || 0) + (status?.invalid.length || 0);
  const totalProgress = progressPercent(progress?.totalProgress);
  const modelProgress = progressPercent(progress?.modelProgress);
  const requiredSize = useMemo(
    () => formatBytes(status?.totalRequiredBytes || null),
    [status?.totalRequiredBytes],
  );

  const refreshStatus = useCallback(async () => {
    const next = await getModelInstallStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void refreshStatus().catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : "Could not check model files.");
    });
  }, [refreshStatus]);

  async function startDownload() {
    setBusy(true);
    setError("");
    try {
      const next = await downloadRequiredModels({
        onProgress: setProgress,
      });
      setStatus(next);
      setProgress({
        phase: "installed",
        totalProgress: 1,
        modelProgress: 1,
        message: "All required local models are installed.",
      });
      requestAnimationFrame(() => router.replace("/(tabs)" as any));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Model download failed.";
      setError(message);
      await refreshStatus().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />
      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          paddingTop: insets.top + 16,
          paddingBottom: Math.max(insets.bottom + 24, 24),
          paddingHorizontal: 18,
          gap: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} style={styles.iconButton}>
            <Ionicons name="chevron-back" size={20} color={Brand.cocoa} />
          </Pressable>
          <View style={styles.tag}>
            <Ionicons name="phone-portrait-outline" size={14} color={Brand.bronze} />
            <Text style={styles.tagText}>On-device model setup</Text>
          </View>
        </View>

        <GlassCard>
          <View style={styles.heroRow}>
            <Text style={styles.title}>Local Gemma/Qwen models</Text>
            <View style={[styles.stateChip, status?.ready && styles.stateChipReady]}>
              <Ionicons
                name={status?.ready ? "checkmark-circle-outline" : "cloud-download-outline"}
                size={14}
                color={Brand.bronze}
              />
              <Text style={styles.stateChipText}>{status?.ready ? "Ready" : "Required"}</Text>
            </View>
          </View>
          <Text style={styles.subtitle}>
            J AI runs the profiler, memory, orchestrator, and alignment agents on the phone.
            Required GGUF files are downloaded into app-private storage and verified before native inference.
          </Text>

          <View style={styles.summaryBox}>
            <Text style={styles.summaryTitle}>Delivery mode</Text>
            <Text style={styles.summaryValue}>{status?.mode || "checking"}</Text>
            <Text style={styles.summaryMeta}>Storage: {status?.storageRoot || "app-private models folder"}</Text>
            <Text style={styles.summaryMeta}>Required download size: {requiredSize}</Text>
            {status?.wifiRecommended ? (
              <Text style={styles.warningText}>Wi‑Fi is recommended because these files can be several GB.</Text>
            ) : null}
          </View>
        </GlassCard>

        <GlassCard>
          <Text style={styles.sectionTitle}>Required files</Text>
          {status?.required.map((model) => (
            <View key={model.id} style={styles.modelRow}>
              <View style={styles.modelIcon}>
                <Ionicons
                  name={model.valid ? "checkmark-circle-outline" : "alert-circle-outline"}
                  size={17}
                  color={model.valid ? Brand.success : Brand.danger}
                />
              </View>
              <View style={styles.modelTextWrap}>
                <Text style={styles.modelTitle}>{model.fileName}</Text>
                <Text style={styles.modelMeta}>{model.id}</Text>
                <Text style={styles.modelMeta}>
                  {model.valid ? `Installed • ${formatBytes(model.bytesOnDisk)}` : model.reason || "Missing"}
                </Text>
              </View>
            </View>
          )) || (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={Brand.cocoa} />
              <Text style={styles.loadingText}>Checking model files…</Text>
            </View>
          )}
        </GlassCard>

        <GlassCard>
          <Text style={styles.sectionTitle}>Download status</Text>
          <Text style={styles.statusText}>
            {progress?.message ||
              (status?.ready
                ? "All required local model files are installed."
                : missingCount
                  ? `${missingCount} model file${missingCount === 1 ? "" : "s"} need download or verification.`
                  : "Checking local model readiness…")}
          </Text>

          {busy ? (
            <View style={styles.progressBlock}>
              <View style={styles.progressHeader}>
                <Text style={styles.progressLabel}>Total</Text>
                <Text style={styles.progressLabel}>{totalProgress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${totalProgress}%` }]} />
              </View>
              <View style={styles.progressHeader}>
                <Text style={styles.progressLabel}>Current model</Text>
                <Text style={styles.progressLabel}>{modelProgress}%</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${modelProgress}%` }]} />
              </View>
            </View>
          ) : null}

          {!!error && <Text style={styles.errorText}>{error}</Text>}

          <Pressable
            onPress={status?.ready ? () => router.replace("/(tabs)" as any) : startDownload}
            disabled={busy}
            style={({ pressed }) => [
              styles.primaryButton,
              busy && styles.buttonDisabled,
              pressed && styles.pressed,
            ]}
          >
            {busy ? <ActivityIndicator color={Brand.ink} /> : null}
            <Text style={styles.primaryButtonText}>
              {status?.ready ? "Continue" : error ? "Retry download" : "Download required models"}
            </Text>
          </Pressable>
        </GlassCard>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.74)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  tagText: { fontSize: 12, fontWeight: "800", color: Brand.cocoa },
  heroRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
  },
  title: { flex: 1, fontSize: 28, lineHeight: 34, fontWeight: "900", color: Brand.ink },
  subtitle: { marginTop: 10, fontSize: 15, lineHeight: 23, color: Brand.muted },
  stateChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.64)",
  },
  stateChipReady: { backgroundColor: "rgba(255,255,255,0.82)" },
  stateChipText: { fontSize: 12, fontWeight: "800", color: Brand.cocoa },
  summaryBox: {
    marginTop: 16,
    padding: 14,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.66)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  summaryTitle: { fontSize: 12, fontWeight: "800", color: Brand.muted, textTransform: "uppercase" },
  summaryValue: { marginTop: 5, fontSize: 16, fontWeight: "900", color: Brand.ink },
  summaryMeta: { marginTop: 6, fontSize: 13, lineHeight: 19, color: Brand.muted },
  warningText: { marginTop: 8, fontSize: 13, lineHeight: 19, color: Brand.danger },
  sectionTitle: { fontSize: 17, fontWeight: "900", color: Brand.ink },
  modelRow: {
    marginTop: 12,
    flexDirection: "row",
    gap: 12,
    padding: 12,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.62)",
  },
  modelIcon: { paddingTop: 2 },
  modelTextWrap: { flex: 1 },
  modelTitle: { fontSize: 14, fontWeight: "900", color: Brand.ink },
  modelMeta: { marginTop: 3, fontSize: 12, lineHeight: 17, color: Brand.muted },
  loadingRow: { marginTop: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  loadingText: { color: Brand.muted, fontSize: 13 },
  statusText: { marginTop: 10, fontSize: 14, lineHeight: 21, color: Brand.muted },
  progressBlock: { marginTop: 16, gap: 8 },
  progressHeader: { flexDirection: "row", justifyContent: "space-between" },
  progressLabel: { fontSize: 12, fontWeight: "800", color: Brand.cocoa },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(124,99,80,0.16)",
  },
  progressFill: { height: "100%", borderRadius: 999, backgroundColor: Brand.bronze },
  errorText: { marginTop: 12, fontSize: 13, lineHeight: 20, color: Brand.danger },
  primaryButton: {
    marginTop: 18,
    minHeight: 54,
    borderRadius: 18,
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Brand.bronze,
  },
  primaryButtonText: { fontSize: 15, fontWeight: "900", color: Brand.ink },
  buttonDisabled: { opacity: 0.56 },
  pressed: { opacity: 0.82, transform: [{ scale: 0.995 }] },
});
