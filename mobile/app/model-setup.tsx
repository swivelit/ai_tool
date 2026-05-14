import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
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
import { isE2eSkipModelSetupEnabled } from "@/lib/e2eMode";
import {
  modelDownloadSession,
  type ModelDownloadSessionSnapshot,
} from "@/lib/modelDownloadSession";
import {
  formatProgressPercentLabel,
  formatSetupEtaText,
  getModelSetupLayout,
} from "@/lib/setupProgressCopy";

export default function ModelSetupScreen() {
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const [snapshot, setSnapshot] = useState<ModelDownloadSessionSnapshot>(
    modelDownloadSession.getSnapshot(),
  );
  const autoContinuedRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);

  const [selectedTier, setSelectedTier] = useState<
  "lite" | "standard" | "pro"
>("lite");

const [setupStarted, setSetupStarted] = useState(false);
  const layout = useMemo(
    () => getModelSetupLayout({ width: dimensions.width, height: dimensions.height }),
    [dimensions.height, dimensions.width],
  );
  const progressValue = Math.max(
    0,
    Math.min(1, Number(snapshot.progress?.totalProgress ?? (snapshot.ready ? 1 : 0)) || 0),
  );
  const progressLabel = formatProgressPercentLabel(progressValue);
  const etaText = useMemo(
    () => formatSetupEtaText({
      status: snapshot.status,
      progress: snapshot.progress,
      ready: snapshot.ready,
    }),
    [snapshot.progress, snapshot.ready, snapshot.status],
  );
  const currentStatusText = snapshot.userMessage;
  const busy =
    snapshot.status === "checking" ||
    snapshot.status === "downloading" ||
    snapshot.status === "reconnecting" ||
    snapshot.status === "verifying";
  const reconnecting = snapshot.status === "reconnecting";
  const manualRetryBusy = busy && !reconnecting;
  const showRetry = snapshot.canRetry && !snapshot.ready;
  const iconName = snapshot.status === "failed"
    ? "alert-circle-outline"
    : snapshot.ready
      ? "checkmark-circle-outline"
      : "phone-portrait-outline";

  useEffect(() => {
    return modelDownloadSession.subscribe(setSnapshot);
  }, []);

  useEffect(() => {
    if (isE2eSkipModelSetupEnabled()) {
      router.replace("/(chat)" as any);
      return;
    }

    let cancelled = false;

    async function startSetup() {
      const deviceInfo = await getCachedDeviceCapabilities().catch(() => null);
      if (cancelled) return;
      await modelDownloadSession.start(deviceInfo ? { deviceInfo } : {});
    }

    if (setupStarted) {
  void startSetup();
}

return () => {
  cancelled = true;
};
}, [setupStarted]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState === "active") {
        if (previousState !== "active") {
          void modelDownloadSession.resume();
        }
        return;
      }
      void modelDownloadSession.pause("background");
    });
    return () => subscription.remove();
  }, []);
const startSelectedSetup = useCallback(() => {
  setSetupStarted(true);

  void modelDownloadSession.start({
    selectedTier,
  } as any);
}, [selectedTier]);

  const retry = useCallback(() => {
    if (manualRetryBusy) return;
    if (snapshot.status === "paused" || snapshot.status === "reconnecting") {
      void modelDownloadSession.resume();
      return;
    }
    void modelDownloadSession.retry();
  }, [manualRetryBusy, snapshot.status]);

  const continueToApp = useCallback(() => {
    router.replace("/(chat)" as any);
  }, []);

  useEffect(() => {
    if (!snapshot.ready || autoContinuedRef.current) return;
    autoContinuedRef.current = true;
    const timer = setTimeout(continueToApp, 700);
    return () => clearTimeout(timer);
  }, [continueToApp, snapshot.ready]);

  const backButtonStyle = useMemo(
    () => [
      styles.iconButton,
      {
        top: insets.top + 10,
        left: layout.horizontalPadding,
      },
    ],
    [insets.top, layout.horizontalPadding],
  );

  const progressHeaderStyle = useMemo(
    () => [
      styles.progressHeader,
      {
        flexDirection: layout.stackProgressLabels ? "column" as const : "row" as const,
        alignItems: layout.stackProgressLabels ? "flex-start" as const : "center" as const,
      },
    ],
    [layout.stackProgressLabels],
  );

  const cardStyle = useMemo(
    () => [
      styles.card,
      {
        width: layout.cardWidth,
        borderRadius: layout.cardRadius,
      },
    ],
    [layout.cardRadius, layout.cardWidth],
  );

  const cardContentStyle = useMemo(
    () => ({ padding: layout.contentPadding }),
    [layout.contentPadding],
  );

  const iconColor = snapshot.status === "failed" ? Brand.danger : Brand.bronze;
  const retryLabel = snapshot.status === "reconnecting" || snapshot.status === "paused"
    ? "Resume"
    : "Retry";

  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.page}>
      <StatusBar style="dark" />
      <Pressable
        onPress={() => router.back()}
        style={backButtonStyle}
        testID="model-setup-back-button"
        accessibilityLabel="model-setup-back-button"
      >
        <Ionicons name="chevron-back" size={20} color={Brand.cocoa} />
      </Pressable>
      <ScrollView
        style={styles.page}
        contentContainerStyle={{
          paddingTop: insets.top + 62,
          paddingBottom: Math.max(insets.bottom + 24, 24),
          paddingHorizontal: layout.horizontalPadding,
          flexGrow: 1,
          justifyContent: "center",
          alignItems: "center",
        }}
        showsVerticalScrollIndicator={false}
      >
        <GlassCard
          style={cardStyle}
          contentStyle={cardContentStyle}
          radius={layout.cardRadius}
        >
          <View
            style={[
              styles.iconWrap,
              {
                width: layout.iconWrapSize,
                height: layout.iconWrapSize,
                borderRadius: layout.iconWrapSize / 2,
              },
            ]}
          >
            <Ionicons
              name={iconName}
              size={layout.iconSize}
              color={iconColor}
            />
          </View>

          <Text
            testID="model-setup-status"
            accessibilityLabel="model-setup-status"
            style={[
              styles.title,
              {
                fontSize: layout.titleSize,
                lineHeight: layout.titleLineHeight,
              },
            ]}
          >
            Preparing Elli for this phone
          </Text>
          <View style={styles.subtitleRow}>
            {reconnecting ? (
              <ActivityIndicator
                size="small"
                color={Brand.bronze}
                testID="model-setup-reconnect-spinner"
              />
            ) : null}
            <Text
              style={[
                styles.subtitle,
                {
                  fontSize: layout.subtitleSize,
                  lineHeight: layout.subtitleLineHeight,
                },
              ]}
            >
              {currentStatusText}
            </Text>
          </View>

<View style={{ marginTop: 20, gap: 12 }}>
  <Text
    style={{
      fontSize: 15,
      fontWeight: "800",
      color: Brand.cocoa,
    }}
  >
    Select model tier
  </Text>

  {[
    {
      id: "lite",
      label: "Lite (Required)",
      desc: "Fast setup with lower storage usage.",
    },
    {
      id: "standard",
      label: "Standard",
      desc: "Balanced quality and performance.",
    },
    {
      id: "pro",
      label: "Pro",
      desc: "Highest quality with larger download.",
    },
  ].map((tier) => (
    <Pressable
      key={tier.id}
      onPress={() => setSelectedTier(tier.id as any)}
      style={{
        padding: 14,
        borderRadius: 16,
        borderWidth: 2,
        borderColor:
          selectedTier === tier.id
            ? Brand.bronze
            : "rgba(0,0,0,0.08)",
        backgroundColor: "rgba(255,255,255,0.55)",
      }}
    >
      <Text
        style={{
          fontWeight: "900",
          color: Brand.ink,
        }}
      >
        {tier.label}
      </Text>

      <Text
        style={{
          marginTop: 4,
          color: Brand.muted,
        }}
      >
        {tier.desc}
      </Text>
    </Pressable>
  ))}
</View>
          <View style={progressHeaderStyle}>
            <Text style={styles.progressLabel}>{progressLabel}</Text>
            <Text style={styles.progressLabel}>{etaText}</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progressValue * 100}%` }]} />
          </View>

          {snapshot.status === "failed" ? (
            <Text style={styles.errorText}>{snapshot.userMessage}</Text>
          ) : null}

          <View style={[styles.actions, layout.compact && styles.actionsCompact]}>
          {!setupStarted && !snapshot.ready ? (
  <Pressable
    onPress={startSelectedSetup}
    style={({ pressed }) => [
      styles.primaryButton,
      pressed && styles.pressed,
    ]}
  >
    <Text style={styles.primaryButtonText}>
      Start Download
    </Text>
  </Pressable>
) : null}
            {showRetry ? (
              <Pressable
                onPress={retry}
                disabled={manualRetryBusy}
                testID="model-setup-retry-button"
                accessibilityLabel="model-setup-retry-button"
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    minHeight: layout.buttonMinHeight,
                    borderRadius: layout.buttonRadius,
                  },
                  manualRetryBusy && styles.buttonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {manualRetryBusy ? (
                  <ActivityIndicator color={Brand.ink} />
                ) : null}
                <Text style={styles.primaryButtonText}>{retryLabel}</Text>
              </Pressable>
            ) : null}

            {snapshot.ready ? (
              <Pressable
                onPress={continueToApp}
                testID="model-setup-continue-button"
                accessibilityLabel="model-setup-download-button"
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    minHeight: layout.buttonMinHeight,
                    borderRadius: layout.buttonRadius,
                  },
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
  iconButton: {
    position: "absolute",
    zIndex: 2,
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
    alignSelf: "center",
  },
  iconWrap: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },
  title: {
    marginTop: 18,
    fontWeight: "900",
    color: Brand.ink,
  },
  subtitleRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  subtitle: {
    color: Brand.muted,
    flex: 1,
    flexShrink: 1,
  },
  progressHeader: {
    marginTop: 24,
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
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
    flexShrink: 1,
  },
  actions: {
    marginTop: 20,
    gap: 10,
  },
  actionsCompact: {
    marginTop: 16,
  },
  primaryButton: {
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
