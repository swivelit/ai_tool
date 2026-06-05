import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

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
        intensity={28}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFillObject}
      />

      <LinearGradient
        colors={[
          "rgba(255,255,255,0.10)",
          "rgba(255,244,224,0.05)",
          "rgba(215,154,89,0.06)",
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />

      <View style={[styles.topSheen, topRadiusStyle]} />
      <View style={[styles.content, contentStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: 24,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,240,220,0.14)",
    backgroundColor: "rgba(24, 22, 31, 0.62)",
    shadowColor: "#000000",
    shadowOpacity: 0.4,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },

  content: {
    padding: 18,
  },

  topSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "46%",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
});
