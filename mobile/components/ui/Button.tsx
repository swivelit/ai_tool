import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

import { Brand, Elevation, Radius, Spacing, Type } from "@/constants/theme";
import { AppText } from "./AppText";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const SIZES: Record<
  ButtonSize,
  { minHeight: number; paddingHorizontal: number; type: keyof typeof Type; icon: number }
> = {
  sm: { minHeight: 40, paddingHorizontal: Spacing.lg, type: "callout", icon: 16 },
  md: { minHeight: 50, paddingHorizontal: Spacing.xl, type: "subheading", icon: 18 },
  lg: { minHeight: 58, paddingHorizontal: Spacing.xxl, type: "subheading", icon: 20 },
};

const LABEL_COLOR: Record<ButtonVariant, string> = {
  primary: Brand.ink,
  secondary: Brand.ink,
  ghost: Brand.cocoa,
  danger: "#fff5f5",
};

/**
 * The shared action button. `primary` is the electric gradient call-to-action;
 * `secondary` is calm glass; `ghost` is text-only; `danger` is destructive.
 * Forwards testID / accessibilityLabel and reflects disabled + busy state.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = true,
  style,
  textStyle,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: keyof typeof Ionicons.glyphMap;
  iconRight?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const sizing = SIZES[size];
  const labelColor = LABEL_COLOR[variant];
  const isDisabled = disabled || loading;

  const content = (
    <View style={styles.row}>
      {loading ? (
        <ActivityIndicator size="small" color={labelColor} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={sizing.icon} color={labelColor} /> : null}
          <AppText
            variant={sizing.type}
            style={[styles.label, { color: labelColor }, textStyle]}
            numberOfLines={1}
          >
            {label}
          </AppText>
          {iconRight ? (
            <Ionicons name={iconRight} size={sizing.icon} color={labelColor} />
          ) : null}
        </>
      )}
    </View>
  );

  const shapeStyle: StyleProp<ViewStyle> = [
    styles.base,
    {
      minHeight: sizing.minHeight,
      paddingHorizontal: sizing.paddingHorizontal,
    },
    fullWidth ? styles.fullWidth : styles.autoWidth,
  ];

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      testID={testID}
      style={({ pressed }) => [
        shapeStyle,
        variant === "secondary" && styles.secondary,
        variant === "ghost" && styles.ghost,
        variant === "danger" && styles.danger,
        pressed && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {variant === "primary" ? (
        <LinearGradient
          colors={Brand.gradients.button}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFillObject, styles.primaryFill]}
        />
      ) : null}
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    ...Elevation.low,
  },
  fullWidth: {
    alignSelf: "stretch",
  },
  autoWidth: {
    alignSelf: "flex-start",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
  },
  label: {
    textAlign: "center",
  },
  primaryFill: {
    borderRadius: Radius.md,
  },
  secondary: {
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: Brand.lineStrong,
  },
  ghost: {
    backgroundColor: "transparent",
    ...Elevation.none,
  },
  danger: {
    backgroundColor: Brand.danger,
  },
  pressed: {
    opacity: 0.86,
    transform: [{ scale: 0.99 }],
  },
  disabled: {
    opacity: 0.45,
  },
});
