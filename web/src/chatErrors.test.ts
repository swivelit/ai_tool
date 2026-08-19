import { expect, it, vi } from 'vitest'
import { ApiError, SSEStreamError } from './api/client'
import { chatErrorMessage } from './chatErrors'

it('formats capacity reset time in the browser locale without provider details', () => {
  const retryAt = '2099-08-01T00:00:00+00:00'
  const locale = vi.spyOn(Date.prototype, 'toLocaleTimeString')
    .mockReturnValue('5:30 AM')
  const message = chatErrorMessage(new SSEStreamError(
    'service_budget_reached',
    'Swico has reached today’s service capacity.',
    true,
    retryAt,
  ), false)

  expect(message).toBe(
    'Swico has reached today’s service capacity. Try again after 5:30 AM.'
  )
  expect(locale).toHaveBeenCalled()
  expect(message).not.toMatch(/openai|gpt|sarvam|model/i)
  locale.mockRestore()
})

it('keeps an interrupted stream distinct from service capacity', () => {
  const message = 'The connection ended before Swico finished. Retry.'
  expect(chatErrorMessage(
    new SSEStreamError('stream_interrupted', message),
    false,
  )).toBe(message)
})

it('uses the backend-safe Swico Free minute-limit message', () => {
  const message = 'Swico Free is temporarily rate limited. Please try again shortly.'
  expect(chatErrorMessage(new ApiError(429, {
    error: { code:'swico_free_rate_limited', message },
  }), false)).toBe(message)
})

it('uses the backend-safe Swico Free daily-limit message', () => {
  const message = 'Swico Free has reached its daily message limit. Please try again tomorrow.'
  expect(chatErrorMessage(new ApiError(429, {
    error: { code:'swico_free_daily_limit', message },
  }), false)).toBe(message)
})

it('keeps generic HTTP 429 responses on the generic rate-limit message', () => {
  expect(chatErrorMessage(new ApiError(429, {
    error: { message:'Some generic backend message' },
  }), false)).toBe('You’re sending messages too quickly. Wait a moment and retry.')
})
