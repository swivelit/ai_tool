import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

import { Brand, Elevation, Radius, Spacing } from "@/constants/theme";

export function GlassCard({
  children,
  style,
  contentStyle,
  radius,
  testID,
  accessibilityLabel,
  accessible,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  radius?: number;
  testID?: string;
  accessibilityLabel?: string;
  accessible?: boolean;
}) {
  const radiusStyle = radius == null ? null : { borderRadius: radius };
  const topRadiusStyle =
    radius == null
      ? null
      : { borderTopLeftRadius: radius, borderTopRightRadius: radius };
  return (
    <View
      testID={testID}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      style={[styles.shell, radiusStyle, style]}
    >
      <BlurView
        intensity={22}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFillObject}
      />

      <LinearGradient
        colors={[
          "rgba(255,255,255,0.075)",
          "rgba(255,255,255,0.032)",
          "rgba(86,222,255,0.045)",
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />

      <View style={[styles.topSheen, topRadiusStyle]} />
      <View style={styles.hairline} pointerEvents="none" />
      <View style={[styles.content, contentStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: Radius.xl,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: Brand.glass,
    ...Elevation.medium,
  },

  content: {
    padding: Spacing.xl,
  },

  topSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "46%",
    backgroundColor: "rgba(255,255,255,0.035)",
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
  },

  hairline: {
    position: "absolute",
    top: 0,
    left: Spacing.lg,
    right: Spacing.lg,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
});
