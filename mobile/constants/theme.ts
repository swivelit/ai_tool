import { Platform } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";

const tintColorLight = "#111111";
const tintColorDark = "#ffffff";

/**
 * Compatibility names used by older screens. New production parity screens
 * should use the semantic palettes below, which mirror the website tokens.
 */
export const Brand = {
  cream: "#ececec",
  warmWhite: "#ececec",
  soft: "#3a3a3a",
  peach: "#ffffff",
  sand: "#b4b4b4",
  caramel: "#ffffff",
  bronze: "#ffffff",
  cocoa: "#b4b4b4",
  ink: "#ececec",
  muted: "#b4b4b4",
  text: "#ececec",
  textMuted: "#b4b4b4",
  line: "#424242",
  lineStrong: "#5a5a5a",
  glass: "#2f2f2f",
  glassStrong: "#171717",
  overlay: "rgba(0, 0, 0, 0.58)",
  danger: "#ff8585",
  success: "#7de2ad",
  night: "#212121",
  charcoal: "#2f2f2f",
  raised: "#2f2f2f",
  gradients: {
    page: ["#212121", "#212121", "#212121"] as const,
    hero: ["#2f2f2f", "#2f2f2f", "#2f2f2f"] as const,
    button: ["#ffffff", "#ffffff", "#ffffff"] as const,
    softCard: ["#2f2f2f", "#2f2f2f"] as const,
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  Adaptive palettes (light + dark)                                          */
/*                                                                            */
/*  `Palette` mirrors every `Brand` key the app already references (so a      */
/*  screen can be re-themed by swapping `Brand.x` → `palette.x`) and adds a    */
/*  handful of semantic tokens for the redesigned chat/voice surfaces. Read    */
/*  the resolved palette through `useAppTheme()`; never hardcode dark colors   */
/*  in new code. `Brand` stays as the dark literal so untouched screens keep   */
/*  working — `darkPalette` is backed by it.                                   */
/* -------------------------------------------------------------------------- */
export type Palette = {
  isDark: boolean;
  // base backgrounds
  background: string;
  night: string;
  charcoal: string;
  raised: string;
  // surfaces / glass
  surface: string;
  surfaceStrong: string;
  sidebar: string;
  composer: string;
  soft: string;
  glass: string;
  glassStrong: string;
  // borders
  line: string;
  lineStrong: string;
  // text
  ink: string;
  text: string;
  cocoa: string;
  muted: string;
  textMuted: string;
  cream: string;
  placeholder: string;
  // accents
  caramel: string;
  bronze: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentText: string;
  online: string;
  // status
  danger: string;
  dangerSoft: string;
  success: string;
  // overlays
  overlay: string;
  scrim: string;
  // ambient glow (Screen)
  glowTop: string;
  glowSide: string;
  glowBottom: string;
  // gradients
  gradients: {
    page: readonly [string, string, string];
    hero: readonly [string, string, string];
    button: readonly [string, string, string];
    softCard: readonly [string, string];
  };
};

/** Dark palette — backs `Brand`, so it is the source of truth for dark mode. */
export const darkPalette: Palette = {
  isDark: true,
  background: Brand.night,
  night: Brand.night,
  charcoal: Brand.charcoal,
  raised: Brand.raised,
  surface: "#2f2f2f",
  surfaceStrong: "#2f2f2f",
  sidebar: "#171717",
  composer: "#303030",
  soft: Brand.soft,
  glass: Brand.glass,
  glassStrong: Brand.glassStrong,
  line: Brand.line,
  lineStrong: Brand.lineStrong,
  ink: Brand.ink,
  text: Brand.text,
  cocoa: Brand.cocoa,
  muted: Brand.muted,
  textMuted: Brand.textMuted,
  cream: Brand.cream,
  placeholder: "#8f8f8f",
  caramel: Brand.caramel,
  bronze: Brand.bronze,
  accent: "#ffffff",
  accentStrong: "#ffffff",
  accentSoft: "#3a3a3a",
  accentText: "#171717",
  online: "#5ce6a8",
  danger: Brand.danger,
  dangerSoft: "rgba(255, 138, 138, 0.16)",
  success: Brand.success,
  overlay: Brand.overlay,
  scrim: "rgba(0, 0, 0, 0.55)",
  glowTop: "transparent",
  glowSide: "transparent",
  glowBottom: "transparent",
  gradients: {
    page: Brand.gradients.page,
    hero: Brand.gradients.hero,
    button: Brand.gradients.button,
    softCard: Brand.gradients.softCard,
  },
};

/** Light palette — airy off-white surfaces with the same electric accents. */
export const lightPalette: Palette = {
  isDark: false,
  background: "#ffffff",
  night: "#ffffff",
  charcoal: "#f7f7f8",
  raised: "#ffffff",
  surface: "#f7f7f8",
  surfaceStrong: "#f7f7f8",
  sidebar: "#f9f9f9",
  composer: "#f4f4f4",
  soft: "#ececec",
  glass: "#f9f9f9",
  glassStrong: "#f9f9f9",
  line: "#dedede",
  lineStrong: "#c8c8c8",
  ink: "#171717",
  text: "#171717",
  cocoa: "#6b6b6b",
  muted: "#6b6b6b",
  textMuted: "#6b6b6b",
  cream: "#ffffff",
  placeholder: "#8a8a8a",
  caramel: "#111111",
  bronze: "#111111",
  accent: "#111111",
  accentStrong: "#111111",
  accentSoft: "#e8e8e8",
  accentText: "#ffffff",
  online: "#16a34a",
  danger: "#dc2626",
  dangerSoft: "#fff0f0",
  success: "#16a34a",
  overlay: "rgba(0, 0, 0, 0.32)",
  scrim: "rgba(0, 0, 0, 0.32)",
  glowTop: "transparent",
  glowSide: "transparent",
  glowBottom: "transparent",
  gradients: {
    page: ["#ffffff", "#ffffff", "#ffffff"],
    hero: ["#f7f7f8", "#f7f7f8", "#f7f7f8"],
    button: ["#111111", "#111111", "#111111"],
    softCard: ["#f7f7f8", "#f7f7f8"],
  },
};

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
