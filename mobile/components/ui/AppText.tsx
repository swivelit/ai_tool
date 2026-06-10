import React from "react";
import { StyleProp, Text, TextProps, TextStyle } from "react-native";

import { Brand, Type, type TypeVariant } from "@/constants/theme";

export type AppTextColor =
  | "default"
  | "muted"
  | "faint"
  | "accent"
  | "danger"
  | "success"
  | "inverse";

const TEXT_COLORS: Record<AppTextColor, string> = {
  default: Brand.ink,
  muted: Brand.textMuted,
  faint: "rgba(150, 162, 179, 0.62)",
  accent: Brand.caramel,
  danger: Brand.danger,
  success: Brand.success,
  inverse: Brand.night,
};

/**
 * The single text primitive. `variant` maps to a step in the {@link Type}
 * scale; `color` maps to a semantic token. All standard `Text` props
 * (testID, accessibilityLabel, numberOfLines, onPress…) pass straight through.
 */
export function AppText({
  variant = "body",
  color = "default",
  style,
  children,
  ...rest
}: TextProps & {
  variant?: TypeVariant;
  color?: AppTextColor;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text {...rest} style={[Type[variant], { color: TEXT_COLORS[color] }, style]}>
      {children}
    </Text>
  );
}
