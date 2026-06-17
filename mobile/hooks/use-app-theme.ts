import { useMemo } from "react";
import { useColorScheme } from "react-native";

import { darkPalette, lightPalette, type Palette } from "@/constants/theme";

export type AppTheme = {
  /** Resolved palette for the active color scheme. */
  palette: Palette;
  /** Convenience flag — drives StatusBar style, glows, etc. */
  isDark: boolean;
  scheme: "light" | "dark";
};

/**
 * Resolves the active palette from the OS color scheme.
 *
 * The app shipped dark-only, so an undetermined scheme (null/undefined) keeps
 * the dark palette; we only switch to light when the device explicitly asks for
 * it. There is no in-app theme override today — if one is ever added to
 * AssistantProvider/settings this is the single place that should honor it.
 */
export function useAppTheme(): AppTheme {
  const scheme = useColorScheme();
  const isDark = scheme !== "light";

  return useMemo(
    () => ({
      palette: isDark ? darkPalette : lightPalette,
      isDark,
      scheme: isDark ? "dark" : "light",
    }),
    [isDark],
  );
}
