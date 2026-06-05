import { Platform } from "react-native";

const tintColorLight = "#ffd99f";
const tintColorDark = "#ffe5b4";

/**
 * Dark "polished glass" palette.
 *
 * Backgrounds sit in the near-black charcoal range (#0e0d12–#1a1820), surfaces
 * are dark glass with low-alpha light borders, and the warm amber family
 * (#ffd99f / #d79a59) is kept as the accent. Foreground tokens that used to be
 * dark ink are now light so body copy reads on the dark canvas; the few tokens
 * that are used as *fills* (bronze, the CTA gradient) stay deep enough that the
 * light label text keeps AA contrast.
 */
export const Brand = {
  // Light "on-dark" / "on-accent" tones (used as text + light fills)
  cream: "#fbf3e7",
  warmWhite: "#f2e9dc",
  // Subtle amber-tinted dark glass surface (used as soft button fills)
  soft: "rgba(255, 218, 161, 0.10)",
  // Bright amber accents
  peach: "#ffd99f",
  sand: "#f0cf9c",
  caramel: "#d79a59",
  // Deep amber — used as a CTA / user-bubble fill behind light text
  bronze: "#9a6328",
  // Warm light amber — icon + secondary label text on the dark canvas
  cocoa: "#e7bc8c",
  // Primary + muted text (light on dark)
  ink: "#f3ebdf",
  muted: "#9c9285",
  text: "#f3ebdf",
  textMuted: "#9c9285",
  // Hairline borders: low-alpha light
  line: "rgba(255, 240, 220, 0.10)",
  lineStrong: "rgba(255, 240, 220, 0.18)",
  // Dark glass surfaces
  glass: "rgba(26, 24, 32, 0.66)",
  glassStrong: "rgba(32, 29, 40, 0.84)",
  overlay: "rgba(0, 0, 0, 0.40)",
  danger: "#f08a72",
  success: "#86c98a",
  // Raw dark canvas stops (handy for solid surfaces)
  night: "#0e0d12",
  charcoal: "#15131b",
  raised: "#1a1820",
  gradients: {
    page: ["#0e0d12", "#141220", "#1a1622"] as const,
    hero: ["#15121f", "#1b1726", "#241c30"] as const,
    // Deep amber CTA — glows on the dark UI while keeping light label contrast
    button: ["#c4843f", "#a06a2c", "#80501e"] as const,
    softCard: ["rgba(38, 34, 48, 0.88)", "rgba(24, 22, 32, 0.82)"] as const,
  },
} as const;

export const Colors = {
  light: {
    text: Brand.text,
    background: Brand.night,
    tint: tintColorLight,
    icon: Brand.muted,
    tabIconDefault: "rgba(255, 229, 180, 0.55)",
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: Brand.warmWhite,
    background: Brand.night,
    tint: tintColorDark,
    icon: "rgba(255, 229, 180, 0.74)",
    tabIconDefault: "rgba(255, 229, 180, 0.60)",
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
