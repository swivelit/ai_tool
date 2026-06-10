import React from "react";
import { StyleProp, StyleSheet, View, ViewStyle } from "react-native";

import { Spacing } from "@/constants/theme";
import { AppText } from "./AppText";

/**
 * A labelled group of content with consistent vertical rhythm. The optional
 * `title` renders as a wide-tracked uppercase eyebrow; `right` docks an action
 * (e.g. a link) opposite it.
 */
export function Section({
  title,
  caption,
  right,
  children,
  style,
  contentStyle,
  gap = Spacing.md,
  testID,
}: {
  title?: string;
  caption?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  gap?: number;
  testID?: string;
}) {
  const hasHeader = Boolean(title || right);
  return (
    <View style={[styles.section, style]} testID={testID}>
      {hasHeader ? (
        <View style={styles.header}>
          {title ? (
            <AppText variant="overline" color="muted" style={styles.title}>
              {title.toUpperCase()}
            </AppText>
          ) : (
            <View />
          )}
          {right}
        </View>
      ) : null}

      {caption ? (
        <AppText variant="caption" color="muted" style={styles.caption}>
          {caption}
        </AppText>
      ) : null}

      {children != null ? (
        <View style={[{ gap }, contentStyle]}>{children}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: Spacing.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing.md,
  },
  title: {
    flex: 1,
  },
  caption: {
    marginTop: -Spacing.xs,
  },
});
