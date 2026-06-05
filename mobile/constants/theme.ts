import { Platform } from "react-native";

const tintColorLight = "#8be9ff";
const tintColorDark = "#d9f8ff";

/**
 * Dark polished-glass palette for the assistant UI.
 *
 * Backgrounds stay near black, surfaces are dark translucent glass, borders are
 * low-alpha white hairlines, and accents use cool electric cyan/blue so the UI
 * no longer reads as the older warm visual treatment.
 */
export const Brand = {
  cream: "#f7fbff",
  warmWhite: "#e9eef7",
  soft: "rgba(255, 255, 255, 0.08)",
  peach: "#8be9ff",
  sand: "#b8c6ff",
  caramel: "#57deff",
  bronze: "#2857d7",
  cocoa: "#c5d1e2",
  ink: "#f2f6fb",
  muted: "#96a2b3",
  text: "#f2f6fb",
  textMuted: "#96a2b3",
  line: "rgba(255, 255, 255, 0.10)",
  lineStrong: "rgba(255, 255, 255, 0.22)",
  glass: "rgba(9, 11, 15, 0.72)",
  glassStrong: "rgba(16, 19, 26, 0.88)",
  overlay: "rgba(0, 0, 0, 0.58)",
  danger: "#ff8a8a",
  success: "#7de2ad",
  night: "#030405",
  charcoal: "#080a0d",
  raised: "#10141b",
  gradients: {
    page: ["#030405", "#07090d", "#10141b"] as const,
    hero: ["#050607", "#0b0f14", "#141923"] as const,
    button: ["#2f73ff", "#17c8d8", "#6e5bff"] as const,
    softCard: ["rgba(19, 23, 32, 0.90)", "rgba(7, 9, 13, 0.88)"] as const,
  },
} as const;

export const Colors = {
  light: {
    text: Brand.text,
    background: Brand.night,
    tint: tintColorLight,
    icon: Brand.muted,
    tabIconDefault: "rgba(225, 238, 255, 0.55)",
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: Brand.warmWhite,
    background: Brand.night,
    tint: tintColorDark,
    icon: "rgba(225, 238, 255, 0.74)",
    tabIconDefault: "rgba(225, 238, 255, 0.60)",
    tabIconSelected: tintColorDark,
  },
};

export const Fonts = Platform.select({
  ios: {
    sans: "system-ui",
    serif: "ui-serif",
    rounded: "ui-rounded",
    mono: "ui-monospace",
  },
  default: {
    sans: "normal",
    serif: "serif",
    rounded: "normal",
    mono: "monospace",
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
