import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import type { Palette } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";

/** Website-aligned full-bleed page background. */
function AmbientGlow({ palette }: { palette: Palette }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.glowTop, { backgroundColor: palette.glowTop }]} />
      <View style={[styles.glowSide, { backgroundColor: palette.glowSide }]} />
      <View style={[styles.glowBottom, { backgroundColor: palette.glowBottom }]} />
    </View>
  );
}

/**
 * Page shell every screen sits on: the shared semantic background. Pass `safeArea={false}` when a
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
  const { palette } = useAppTheme();

  return (
    <View
      style={[styles.fill, { backgroundColor: palette.background }, style]}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    >
      {glow ? <AmbientGlow palette={palette} /> : null}
      {safeArea ? (
        <SafeAreaView edges={edges} style={[styles.fill, contentStyle]}>
          {children}
        </SafeAreaView>
      ) : (
        <View style={[styles.fill, contentStyle]}>{children}</View>
      )}
    </View>
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
  },
  glowSide: {
    position: "absolute",
    top: 180,
    left: -140,
    width: 300,
    height: 300,
    borderRadius: 300,
  },
  glowBottom: {
    position: "absolute",
    bottom: -180,
    left: 40,
    right: 40,
    height: 320,
    borderRadius: 320,
  },
});
