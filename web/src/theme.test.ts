import { expect, it, vi } from 'vitest'
import { applyTheme, resolveTheme } from './theme'

it('respects system preference initially and persists an explicit theme', () => {
  const storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() }
  expect(resolveTheme(storage, true)).toBe('dark')
  applyTheme('light', storage); expect(document.documentElement.dataset.theme).toBe('light')
  expect(storage.setItem).toHaveBeenCalledWith('swico-theme', 'light')
  storage.getItem.mockReturnValue('dark'); expect(resolveTheme(storage, false)).toBe('dark')
})
