import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router, usePathname, useRootNavigationState, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import { AuthProvider, useAuth } from "@/components/AuthProvider";
import { AssistantProvider, useAssistant } from "@/components/AssistantProvider";
import { GlassCard } from "@/components/Glass";
import { Brand } from "@/constants/theme";
import { resolveDesiredRoute } from "@/lib/appBoot";

type AlertButtonConfig = {
  text?: string;
  onPress?: (() => void) | undefined;
  style?: "default" | "cancel" | "destructive";
};

type AlertOptionsConfig = {
  cancelable?: boolean;
  onDismiss?: (() => void) | undefined;
};

type AlertState = {
  title: string;
  message: string;
  buttons: AlertButtonConfig[];
  cancelable: boolean;
  onDismiss?: (() => void) | undefined;
} | null;

function BootScreen() {
  return (
    <LinearGradient colors={Brand.gradients.page} style={styles.bootPage}>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={styles.topGlow} />
        <View style={styles.leftGlow} />
        <View style={styles.bottomGlow} />
      </View>

      <GlassCard style={styles.bootCardShell}>
        <View style={styles.bootCard}>
          <ActivityIndicator size="small" color={Brand.bronze} />
          <Text style={styles.bootTitle}>Loading J AI...</Text>
          <Text style={styles.bootText}>Setting things up.</Text>
        </View>
      </GlassCard>
    </LinearGradient>
  );
}

function UnifiedAlertHost({ children }: { children: React.ReactNode }) {
  const [alertState, setAlertState] = useState<AlertState>(null);

  useEffect(() => {
    const originalAlert = Alert.alert;

    (Alert as any).alert = (
      title?: string,
      message?: string,
      buttons?: AlertButtonConfig[],
      options?: AlertOptionsConfig
    ) => {
      setAlertState({
        title: String(title || "Notice"),
        message: String(message || ""),
        buttons: Array.isArray(buttons) && buttons.length ? buttons : [{ text: "OK" }],
        cancelable: Boolean(options?.cancelable),
        onDismiss: options?.onDismiss,
      });
    };

    return () => {
      (Alert as any).alert = originalAlert;
    };
  }, []);

  const buttons = alertState?.buttons?.length ? alertState.buttons : [{ text: "OK" }];

  let primaryButtonIndex = 0;
  for (let index = buttons.length - 1; index >= 0; index -= 1) {
    if (buttons[index]?.style !== "cancel") {
      primaryButtonIndex = index;
      break;
    }
  }

  const lowerCopy = `${alertState?.title || ""} ${alertState?.message || ""}`.toLowerCase();
  const hasDestructiveAction = buttons.some((button) => button.style === "destructive");
  const isErrorLike = /(error|failed|couldn.?t|invalid|missing|permission)/i.test(lowerCopy);
  const isSuccessLike = /(saved|updated|success|scheduled|reminder set|done)/i.test(lowerCopy);

  const accentColor =
    hasDestructiveAction || isErrorLike
      ? Brand.danger
      : isSuccessLike
        ? Brand.success
        : Brand.bronze;

  const iconName: keyof typeof Ionicons.glyphMap = hasDestructiveAction
    ? "trash-outline"
    : isErrorLike
      ? "alert-circle-outline"
      : isSuccessLike
        ? "checkmark-circle-outline"
        : "information-circle-outline";

  function closeAlert(runDismiss = false) {
    const dismiss = alertState?.onDismiss;
    setAlertState(null);

    if (runDismiss && dismiss) {
      requestAnimationFrame(() => {
        dismiss();
      });
    }
  }

  function handleButtonPress(button?: AlertButtonConfig) {
    const callback = button?.onPress;
    setAlertState(null);

    if (callback) {
      requestAnimationFrame(() => {
        callback();
      });
    }
  }

  return (
    <>
      {children}

      <Modal
        transparent
        visible={Boolean(alertState)}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => {
          if (alertState?.cancelable) {
            closeAlert(true);
          }
        }}
      >
        <View style={styles.alertOverlay}>
          {alertState?.cancelable ? (
            <Pressable style={StyleSheet.absoluteFill} onPress={() => closeAlert(true)} />
          ) : null}

          <View style={styles.alertCardWrap}>
            <GlassCard style={styles.alertCard}>
              <View style={styles.alertIconWrap}>
                <Ionicons name={iconName} size={24} color={accentColor} />
              </View>

              <Text style={styles.alertTitle}>{alertState?.title}</Text>

              {alertState?.message ? (
                <Text style={styles.alertMessage}>{alertState.message}</Text>
              ) : null}

              <View style={styles.alertActions}>
                {buttons.map((button, index) => {
                  const label = (button.text || (index === primaryButtonIndex ? "OK" : "Close")).trim();
                  const isPrimary = index === primaryButtonIndex;
                  const isDestructive = button.style === "destructive";

                  if (isPrimary && !isDestructive) {
                    return (
                      <Pressable
                        key={`${label}-${index}`}
                        onPress={() => handleButtonPress(button)}
                        style={({ pressed }) => [
                          styles.alertButtonBase,
                          styles.alertPrimaryButton,
                          pressed && styles.alertPressed,
                        ]}
                      >
                        <Text style={styles.alertPrimaryText}>{label}</Text>
                      </Pressable>
                    );
                  }

                  return (
                    <Pressable
                      key={`${label}-${index}`}
                      onPress={() => handleButtonPress(button)}
                      style={({ pressed }) => [
                        styles.alertButtonBase,
                        styles.alertSecondaryButton,
                        isDestructive && styles.alertDestructiveButton,
                        pressed && styles.alertPressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.alertSecondaryText,
                          isDestructive && styles.alertDestructiveText,
                        ]}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </GlassCard>
          </View>
        </View>
      </Modal>
    </>
  );
}

function toRawPath(path?: string | null) {
  if (!path) {
    return "/";
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function AppShell() {
  const pathname = usePathname();
  const segments = useSegments();
  const rootNavigationState = useRootNavigationState();

  const { user, loading: authLoading } = useAuth();
  const { profile, loading: profileLoading } = useAssistant();

  const lastRedirectRef = useRef<string | null>(null);

  const activeProfile = useMemo(() => {
    if (!user) return null;
    if (!profile) return null;
    if (profile.firebaseUid && profile.firebaseUid !== user.uid) return null;
    return profile;
  }, [profile, user]);

  const targetRoute = useMemo(
    () =>
      resolveDesiredRoute({
        pathname,
        hasUser: Boolean(user),
        hasProfile: Boolean(activeProfile?.userId),
        questionnaireCompleted: Boolean(activeProfile?.questionnaireCompleted),
        profileRestoreFailed: Boolean(activeProfile?.restoreFailed),
        inTabsGroup: segments[0] === "(tabs)",
      }),
    [
      pathname,
      segments,
      user,
      activeProfile?.userId,
      activeProfile?.questionnaireCompleted,
      activeProfile?.restoreFailed,
    ]
  );

  const isNavigatorReady = Boolean(rootNavigationState?.key);
  const shouldShowBoot = authLoading || profileLoading || !isNavigatorReady;

  useEffect(() => {
    if (shouldShowBoot) {
      return;
    }

    if (!targetRoute) {
      lastRedirectRef.current = null;
      return;
    }

    const currentPath = toRawPath(pathname);
    const nextPath = toRawPath(targetRoute);

    if (currentPath === nextPath) {
      lastRedirectRef.current = null;
      return;
    }

    const redirectKey = `${currentPath}->${nextPath}`;

    if (lastRedirectRef.current === redirectKey) {
      return;
    }

    lastRedirectRef.current = redirectKey;

    const frame = requestAnimationFrame(() => {
      router.replace(targetRoute as any);
    });

    return () => cancelAnimationFrame(frame);
  }, [shouldShowBoot, pathname, targetRoute]);

  return (
    <View style={styles.appShell}>
      <StatusBar style="dark" />

      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="auth/login" />
        <Stack.Screen name="auth/signup" />
        <Stack.Screen name="onboarding/profile" />
        <Stack.Screen name="onboarding/questionnaire" />
        <Stack.Screen name="setup" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="item/[id]" />
        <Stack.Screen name="modal" options={{ presentation: "modal" }} />
      </Stack>

      {!shouldShowBoot && activeProfile?.restoreFailed ? (
        <View style={styles.restoreOverlay}>
          <GlassCard style={styles.restoreCard}>
            <Text style={styles.restoreTitle}>Couldn’t restore profile</Text>
            <Text style={styles.restoreText}>
              We could not restore your profile. Check your connection and try again.
            </Text>
          </GlassCard>
        </View>
      ) : null}

      {shouldShowBoot ? (
        <View style={styles.bootOverlay}>
          <BootScreen />
        </View>
      ) : null}
    </View>
  );
}

function RootNavigator() {
  return (
    <AssistantProvider>
      <UnifiedAlertHost>
        <AppShell />
      </UnifiedAlertHost>
    </AssistantProvider>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  appShell: {
    flex: 1,
  },

  bootOverlay: {
    ...StyleSheet.absoluteFillObject,
  },

  restoreOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    backgroundColor: "rgba(255,248,240,0.86)",
  },

  restoreCard: {
    padding: 18,
    gap: 8,
  },

  restoreTitle: {
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  restoreText: {
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 20,
  },

  bootPage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },

  bootCardShell: {
    borderRadius: 28,
    minWidth: 240,
  },

  bootCard: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },

  bootTitle: {
    color: Brand.ink,
    fontSize: 18,
    fontWeight: "900",
  },

  bootText: {
    color: Brand.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },

  alertOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    backgroundColor: "rgba(72, 46, 18, 0.18)",
  },

  alertCardWrap: {
    width: "100%",
    maxWidth: 420,
  },

  alertCard: {
    borderRadius: 28,
  },

  alertIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: Brand.line,
  },

  alertTitle: {
    color: Brand.ink,
    marginTop: 14,
    fontSize: 22,
    fontWeight: "900",
  },

  alertMessage: {
    marginTop: 10,
    color: Brand.muted,
    fontSize: 14,
    lineHeight: 22,
  },

  alertActions: {
    marginTop: 18,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    flexWrap: "wrap",
  },

  alertButtonBase: {
    minWidth: 104,
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },

  alertPrimaryButton: {
    backgroundColor: "#efbf7c",
  },

  alertPrimaryText: {
    color: Brand.ink,
    fontSize: 14,
    fontWeight: "900",
  },

  alertSecondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Brand.lineStrong,
    backgroundColor: "rgba(255,255,255,0.62)",
  },

  alertSecondaryText: {
    color: Brand.cocoa,
    fontSize: 14,
    fontWeight: "800",
  },

  alertDestructiveButton: {
    backgroundColor: Brand.danger,
    borderColor: Brand.danger,
  },

  alertDestructiveText: {
    color: "#fff8f5",
  },

  alertPressed: {
    opacity: 0.85,
  },

  topGlow: {
    position: "absolute",
    top: -120,
    right: -80,
    width: 260,
    height: 260,
    borderRadius: 160,
    backgroundColor: "rgba(244, 191, 117, 0.18)",
  },

  leftGlow: {
    position: "absolute",
    left: -110,
    top: 110,
    width: 220,
    height: 220,
    borderRadius: 140,
    backgroundColor: "rgba(236, 206, 152, 0.12)",
  },

  bottomGlow: {
    position: "absolute",
    bottom: -130,
    left: 20,
    width: 260,
    height: 260,
    borderRadius: 180,
    backgroundColor: "rgba(212, 154, 79, 0.10)",
  },
});