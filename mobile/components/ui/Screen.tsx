import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { Brand } from "@/constants/theme";

/** Calm, full-bleed page background: dark gradient + restrained ambient glow. */
function AmbientGlow() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.glowTop} />
      <View style={styles.glowSide} />
      <View style={styles.glowBottom} />
    </View>
  );
}

/**
 * Page shell every screen sits on: the shared dark gradient, an optional
 * ambient glow, and a safe-area container. Pass `safeArea={false}` when a
 * screen manages its own insets (e.g. keyboard-aware composers).
 */
export function Screen({
  children,
  style,
  contentStyle,
  edges = ["top", "bottom"],
  glow = true,
  safeArea = true,
  testID,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  edges?: readonly Edge[];
  glow?: boolean;
  safeArea?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <LinearGradient
      colors={Brand.gradients.page}
      style={[styles.fill, style]}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    >
      {glow ? <AmbientGlow /> : null}
      {safeArea ? (
        <SafeAreaView edges={edges} style={[styles.fill, contentStyle]}>
          {children}
        </SafeAreaView>
      ) : (
        <View style={[styles.fill, contentStyle]}>{children}</View>
      )}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  glowTop: {
    position: "absolute",
    top: -160,
    right: -120,
    width: 360,
    height: 360,
    borderRadius: 360,
    backgroundColor: "rgba(40, 87, 215, 0.16)",
  },
  glowSide: {
    position: "absolute",
    top: 180,
    left: -140,
    width: 300,
    height: 300,
    borderRadius: 300,
    backgroundColor: "rgba(87, 222, 255, 0.08)",
  },
  glowBottom: {
    position: "absolute",
    bottom: -180,
    left: 40,
    right: 40,
    height: 320,
    borderRadius: 320,
    backgroundColor: "rgba(110, 91, 255, 0.10)",
  },
});
