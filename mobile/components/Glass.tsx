import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";

import { Elevation, Radius, Spacing } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * Card surface used across ~16 screens.
 *
 * Was a stack of BlurView + near-white gradient film + a top "sheen" overlay
 * over the near-black page, which composited into a hazy, glossy panel and
 * smeared the text on top. It is now a single OPAQUE, theme-aware surface:
 * a solid themed fill, one hairline border, rounded corners and a soft
 * elevation shadow — crisp and readable in both light and dark mode.
 *
 * The public API is unchanged so every existing call site keeps working.
 */
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
  const { palette } = useAppTheme();
  const radiusStyle = radius == null ? null : { borderRadius: radius };

  return (
    <View
      testID={testID}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.shell,
        {
          // Dark: a fully opaque raised panel so the card reads as a clean
          // solid surface against the page gradient + ambient glow (no
          // see-through). Light: the opaque white surface token.
          backgroundColor: palette.isDark
            ? palette.raised
            : palette.surfaceStrong,
          borderColor: palette.line,
        },
        radiusStyle,
        style,
      ]}
    >
      <View style={[styles.content, contentStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: Radius.xl,
    overflow: "hidden",
    borderWidth: 1,
    ...Elevation.medium,
  },

  content: {
    padding: Spacing.xl,
  },
});
