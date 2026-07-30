import { expect, it, vi } from 'vitest'
import { SSEStreamError } from './api/client'
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
