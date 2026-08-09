import { useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { darkPalette, lightPalette, type Palette } from "@/constants/theme";

export type AppTheme = {
  /** Resolved palette for the active color scheme. */
  palette: Palette;
  /** Convenience flag — drives StatusBar style, glows, etc. */
  isDark: boolean;
  scheme: "light" | "dark";
  themePreference: "light" | "dark" | "system";
  setThemePreference: (value: "light" | "dark" | "system") => Promise<void>;
};

const themeListeners = new Set<(value: "light" | "dark" | "system") => void>();

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
  const [preference, setPreference] = useState<"light" | "dark" | "system">("system");
  useEffect(() => { void AsyncStorage.getItem("swico.theme.preference").then(value => { if (value === "light" || value === "dark" || value === "system") setPreference(value); }).catch(() => undefined); }, []);
  useEffect(() => {
    const listener = (value: "light" | "dark" | "system") => setPreference(value);
    themeListeners.add(listener);
    return () => { themeListeners.delete(listener); };
  }, []);
  const isDark = (preference === "system" ? scheme !== "light" : preference === "dark");
  const setThemePreference = async (value: "light" | "dark" | "system") => { themeListeners.forEach(listener => listener(value)); await AsyncStorage.setItem("swico.theme.preference", value); };

  return useMemo(
    () => ({
      palette: isDark ? darkPalette : lightPalette,
      isDark,
      scheme: isDark ? "dark" : "light",
      themePreference: preference,
      setThemePreference,
    }),
    [isDark, preference],
  );
}
