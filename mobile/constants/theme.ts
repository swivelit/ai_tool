import { Platform } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

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

/* -------------------------------------------------------------------------- */
/*  Design tokens                                                             */
/*                                                                            */
/*  These power the shared primitives in `components/ui` and every screen.    */
/*  Reference them instead of hardcoding fontSize / padding / radius / shadow */
/*  so the whole app stays on one calm, high-contrast system.                 */
/* -------------------------------------------------------------------------- */

/**
 * Typographic scale — eight confident steps.
 *
 * Display/title carry tight negative tracking for an editorial, intellectual
 * feel; body relaxes to a readable weight; `overline` is the wide-tracked
 * uppercase eyebrow. Each step is a complete `TextStyle` slice you can spread
 * or hand to `<AppText variant="…" />`.
 */
export const Type = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -0.6 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: "800", letterSpacing: -0.4 },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: "700", letterSpacing: -0.2 },
  subheading: { fontSize: 17, lineHeight: 24, fontWeight: "700", letterSpacing: -0.1 },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "500", letterSpacing: 0 },
  callout: { fontSize: 14, lineHeight: 20, fontWeight: "600", letterSpacing: 0 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "600", letterSpacing: 0.1 },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 1.4 },
} as const satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof Type;

/** Spacing — a 4/8-based rhythm. Use for padding, margins and gaps. */
export const Spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  mega: 48,
} as const;

export type SpacingKey = keyof typeof Spacing;

/** Corner radii. `pill` fully rounds; sizes map to surfaces and fields. */
export const Radius = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 28,
  pill: 999,
} as const;

export type RadiusKey = keyof typeof Radius;

/**
 * Named shadow presets. Spread into a `View` style: `...Elevation.medium`.
 * `glow` is the cool electric halo used around interactive/AI surfaces.
 */
export const Elevation = {
  none: {
    shadowColor: "transparent",
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  low: {
    shadowColor: "#000000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  medium: {
    shadowColor: "#000000",
    shadowOpacity: 0.4,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },
  high: {
    shadowColor: "#000000",
    shadowOpacity: 0.52,
    shadowRadius: 40,
    shadowOffset: { width: 0, height: 22 },
    elevation: 20,
  },
  glow: {
    shadowColor: "#57deff",
    shadowOpacity: 0.45,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
} as const satisfies Record<string, ViewStyle>;

export type ElevationKey = keyof typeof Elevation;

/**
 * Motion language. Durations in ms; easings are framework-agnostic cubic
 * bezier control points — apply with `Easing.bezier(...Motion.easing.standard)`
 * from either react-native or react-native-reanimated.
 */
export const Motion = {
  duration: {
    instant: 90,
    fast: 160,
    base: 240,
    slow: 360,
    slower: 560,
    ambient: 2600,
  },
  easing: {
    standard: [0.4, 0, 0.2, 1],
    decelerate: [0, 0, 0.2, 1],
    accelerate: [0.4, 0, 1, 1],
    emphasized: [0.2, 0, 0, 1],
    spring: [0.34, 1.26, 0.64, 1],
  },
} as const;
