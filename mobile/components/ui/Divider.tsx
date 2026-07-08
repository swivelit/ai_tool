import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";

import { Brand, Spacing } from "@/constants/theme";
import { AppText } from "./AppText";

/**
 * A low-alpha hairline. With a `label` it becomes a centered "or"-style
 * separator; without one it is a plain rule.
 */
export function Divider({
  label,
  style,
}: {
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  if (!label) {
    return <View style={[styles.line, style]} />;
  }

  return (
    <View style={[styles.row, style]}>
      <View style={styles.flexLine} />
      <AppText variant="overline" color="faint">
        {label.toUpperCase()}
      </AppText>
      <View style={styles.flexLine} />
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    height: 1,
    alignSelf: "stretch",
    backgroundColor: Brand.line,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
  },
  flexLine: {
    flex: 1,
    height: 1,
    backgroundColor: Brand.line,
  },
});
