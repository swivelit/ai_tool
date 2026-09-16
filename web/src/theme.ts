export type Theme = 'light' | 'dark'
export type ColorStyle =
  | 'swico'
  | 'ocean'
  | 'aurora'
  | 'forest'
  | 'sunset'
  | 'custom'

export type CustomColors = {
  primary: string
  secondary: string
  accent: string
}

const COLOR_STYLES: ColorStyle[] = [
  'swico',
  'ocean',
  'aurora',
  'forest',
  'sunset',
  'custom',
]
const DEFAULT_CUSTOM_COLORS: CustomColors = {
  primary: '#6366f1',
  secondary: '#8b5cf6',
  accent: '#ec4899',
}

export function resolveTheme(storage: Pick<Storage, 'getItem'> = localStorage, darkPreferred = window.matchMedia('(prefers-color-scheme: dark)').matches): Theme {
  const saved = storage.getItem('swico-theme')
  return saved === 'light' || saved === 'dark' ? saved : darkPreferred ? 'dark' : 'light'
}

export function applyTheme(theme: Theme, storage: Pick<Storage, 'setItem'> = localStorage): void {
  document.documentElement.dataset.theme = theme; storage.setItem('swico-theme', theme)
}

export function resolveColorStyle(
  storage: Pick<Storage, 'getItem'> = localStorage,
): ColorStyle {
  const saved = storage.getItem('swico-color-style')

  return COLOR_STYLES.includes(saved as ColorStyle)
    ? saved as ColorStyle
    : 'swico'
}

export function applyColorStyle(
  colorStyle: ColorStyle,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  document.documentElement.dataset.colorStyle = colorStyle
  storage.setItem('swico-color-style', colorStyle)
}
export function resolveCustomColors(
  storage: Pick<Storage, 'getItem'> = localStorage,
): CustomColors {
  const primary = storage.getItem('swico-custom-primary')
  const secondary = storage.getItem('swico-custom-secondary')
  const accent = storage.getItem('swico-custom-accent')

  return {
    primary: primary || DEFAULT_CUSTOM_COLORS.primary,
    secondary: secondary || DEFAULT_CUSTOM_COLORS.secondary,
    accent: accent || DEFAULT_CUSTOM_COLORS.accent,
  }
}
export function applyCustomColors(
  colors: CustomColors,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  document.documentElement.style.setProperty(
    '--custom-primary',
    colors.primary,
  )

  document.documentElement.style.setProperty(
    '--custom-secondary',
    colors.secondary,
  )

  document.documentElement.style.setProperty(
    '--custom-accent',
    colors.accent,
  )

  storage.setItem('swico-custom-primary', colors.primary)
  storage.setItem('swico-custom-secondary', colors.secondary)
  storage.setItem('swico-custom-accent', colors.accent)
}