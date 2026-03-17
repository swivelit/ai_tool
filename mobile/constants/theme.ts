import { Platform } from 'react-native';

const tintColorLight = '#c88c46';
const tintColorDark = '#ffe5b4';

export const Brand = {
  cream: '#fffaf2',
  warmWhite: '#fff6e8',
  soft: '#fff0d0',
  peach: '#ffe5b4',
  sand: '#f3d2a2',
  caramel: '#d79a59',
  bronze: '#b97836',
  cocoa: '#7c5434',
  ink: '#2f2118',
  muted: '#7c6350',
  line: 'rgba(99, 64, 34, 0.14)',
  lineStrong: 'rgba(99, 64, 34, 0.22)',
  glass: 'rgba(255, 249, 239, 0.72)',
  glassStrong: 'rgba(255, 244, 224, 0.88)',
  overlay: 'rgba(89, 56, 27, 0.08)',
  danger: '#b96248',
  success: '#6f8c5e',
  gradients: {
    page: ['#fffaf2', '#fff2d8', '#ffe5b4'] as const,
    hero: ['#fff6e8', '#ffeac2', '#ffdca4'] as const,
    button: ['#edbb77', '#d89a57', '#c4823d'] as const,
    softCard: ['rgba(255,255,255,0.95)', 'rgba(255,236,204,0.92)'] as const,
  },
} as const;

export const Colors = {
  light: {
    text: Brand.ink,
    background: Brand.cream,
    tint: tintColorLight,
    icon: Brand.muted,
    tabIconDefault: 'rgba(124, 99, 80, 0.72)',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: Brand.warmWhite,
    background: '#2a1e16',
    tint: tintColorDark,
    icon: 'rgba(255, 229, 180, 0.74)',
    tabIconDefault: 'rgba(255, 229, 180, 0.60)',
    tabIconSelected: tintColorDark,
  },
};

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});