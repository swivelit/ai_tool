import { expect, it, vi } from 'vitest'
import {
  applyColorStyle,
  applyCustomColors,
  applyTheme,
  resolveColorStyle,
  resolveCustomColors,
  resolveTheme,
} from './theme'

it('respects system preference initially and persists an explicit theme', () => {
  const storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() }

  expect(resolveTheme(storage, true)).toBe('dark')

  applyTheme('light', storage)
  expect(document.documentElement.dataset.theme).toBe('light')

  expect(storage.setItem).toHaveBeenCalledWith('swico-theme', 'light')

  storage.getItem.mockReturnValue('dark')
  expect(resolveTheme(storage, false)).toBe('dark')
})

it('defaults to the SWICO color style and persists an explicit style', () => {
  const storage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
  }

  expect(resolveColorStyle(storage)).toBe('swico')

  applyColorStyle('ocean', storage)

  expect(document.documentElement.dataset.colorStyle).toBe('ocean')
  expect(storage.setItem).toHaveBeenCalledWith(
    'swico-color-style',
    'ocean',
  )
})

it('accepts only supported color styles', () => {
  const storage = {
    getItem: vi.fn().mockReturnValue('ocean'),
    setItem: vi.fn(),
  }

  expect(resolveColorStyle(storage)).toBe('ocean')

  storage.getItem.mockReturnValue('invalid-style')
  expect(resolveColorStyle(storage)).toBe('swico')

  storage.getItem.mockReturnValue('aurora')
  expect(resolveColorStyle(storage)).toBe('aurora')
})

it('applies every supported color style', () => {
  const storage = {
    getItem: vi.fn(),
    setItem: vi.fn(),
  }

  const styles = [
    'swico',
    'ocean',
    'aurora',
    'forest',
    'sunset',
    'custom',
  ] as const

  for (const style of styles) {
    applyColorStyle(style, storage)

    expect(document.documentElement.dataset.colorStyle).toBe(style)
    expect(storage.setItem).toHaveBeenLastCalledWith(
      'swico-color-style',
      style,
    )
  }
})

it('defaults to the standard custom colors and persists explicit custom colors', () => {
  const storage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
  }

  expect(resolveCustomColors(storage)).toEqual({
    primary: '#6366f1',
    secondary: '#8b5cf6',
    accent: '#ec4899',
  })

  const colors = {
    primary: '#123456',
    secondary: '#654321',
    accent: '#abcdef',
  }

  applyCustomColors(colors, storage)

  expect(document.documentElement.style.getPropertyValue('--custom-primary'))
    .toBe('#123456')
  expect(document.documentElement.style.getPropertyValue('--custom-secondary'))
    .toBe('#654321')
  expect(document.documentElement.style.getPropertyValue('--custom-accent'))
    .toBe('#abcdef')

  expect(storage.setItem).toHaveBeenCalledWith(
    'swico-custom-primary',
    '#123456',
  )
  expect(storage.setItem).toHaveBeenCalledWith(
    'swico-custom-secondary',
    '#654321',
  )
  expect(storage.setItem).toHaveBeenCalledWith(
    'swico-custom-accent',
    '#abcdef',
  )
})
it('restores saved custom colors', () => {
  const storage = {
    getItem: vi.fn((key: string) => {
      const values: Record<string, string> = {
        'swico-custom-primary': '#111111',
        'swico-custom-secondary': '#222222',
        'swico-custom-accent': '#333333',
      }

      return values[key] ?? null
    }),
    setItem: vi.fn(),
  }

  expect(resolveCustomColors(storage)).toEqual({
    primary: '#111111',
    secondary: '#222222',
    accent: '#333333',
  })
})