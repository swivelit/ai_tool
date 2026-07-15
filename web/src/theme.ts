export type Theme = 'light' | 'dark'

export function resolveTheme(storage: Pick<Storage, 'getItem'> = localStorage, darkPreferred = window.matchMedia('(prefers-color-scheme: dark)').matches): Theme {
  const saved = storage.getItem('swico-theme')
  return saved === 'light' || saved === 'dark' ? saved : darkPreferred ? 'dark' : 'light'
}

export function applyTheme(theme: Theme, storage: Pick<Storage, 'setItem'> = localStorage): void {
  document.documentElement.dataset.theme = theme; storage.setItem('swico-theme', theme)
}
