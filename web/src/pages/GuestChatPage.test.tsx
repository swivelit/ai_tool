import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { GuestChatPage } from './GuestChatPage'
import {
  ApiError, cancelGuestChatRequest, clearStoredGuestToken, createGuestSession,
  getStoredGuestToken, streamGuestChat,
} from '../api/client'

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    clearStoredGuestToken: vi.fn(),
    createGuestSession: vi.fn(),
    getStoredGuestToken: vi.fn(),
    streamGuestChat: vi.fn(),
    cancelGuestChatRequest: vi.fn(),
  }
})

const guestSession = {
  guest_token: 'g'.repeat(64), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  assistant: { tier:'free' as const, tier_label:'Swico Free' as const },
  limits: { max_message_characters:16_000, daily_message_limit:10 },
}

beforeEach(() => {
  vi.mocked(getStoredGuestToken).mockReset().mockReturnValue(null)
  vi.mocked(createGuestSession).mockReset().mockResolvedValue(guestSession)
  vi.mocked(streamGuestChat).mockReset()
  vi.mocked(clearStoredGuestToken).mockReset()
  vi.mocked(cancelGuestChatRequest).mockReset().mockResolvedValue({ status: 'cancelling' })
})

function renderGuest() {
  return render(<MemoryRouter><GuestChatPage /></MemoryRouter>)
}

it('renders the restricted guest experience without account controls', () => {
  renderGuest()
  expect(screen.getByRole('link', { name:'Log in' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name:'Sign up for free' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name:'How can Swico help?' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name:'Message Swico' })).toBeInTheDocument()
  expect(screen.getByText('Swico Free')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name:/Swico Lite|Swico Pro|Swico$/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:'Add to prompt' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name:/Voice/ })).not.toBeInTheDocument()
  expect(screen.queryByText(/wallet|billing|settings|search chats|archived/i)).not.toBeInTheDocument()
})

it('creates a guest session lazily and renders incremental Free SSE events', async () => {
  vi.mocked(streamGuestChat).mockImplementation(async (_token, _payload, onEvent) => {
    onEvent({ event:'thread', data:{ thread_id:'thread-1' } })
    onEvent({ event:'delta', data:{ text:'Hello' } })
    onEvent({ event:'delta', data:{ text:' from Free' } })
    onEvent({ event:'usage', data:{ tier:'free', tier_label:'Swico Free', input_tokens:2, output_tokens:3, usage_source:'actual', charged_micros:0 } })
    onEvent({ event:'done', data:{ message_id:'message-1', thread_id:'thread-1', completion_status:'complete' } })
  })
  renderGuest()
  expect(createGuestSession).not.toHaveBeenCalled()
  await userEvent.type(screen.getByRole('textbox', { name:'Message Swico' }), 'hello')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(createGuestSession).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByText('Hello from Free')).toBeInTheDocument())
  expect(streamGuestChat).toHaveBeenCalledWith(guestSession.guest_token, expect.objectContaining({ input_mode:'text', message:'hello' }), expect.any(Function), expect.any(AbortSignal), expect.any(Function))
})

it('starts a new local chat without calling any history endpoint', async () => {
  renderGuest()
  await userEvent.click(screen.getByRole('button', { name:/New chat/ }))
  expect(screen.getByRole('heading', { name:'How can Swico help?' })).toBeInTheDocument()
})

it('cancels guest generation through the guest-scoped endpoint', async () => {
  vi.mocked(streamGuestChat).mockImplementation(async (_token, _payload, _onEvent, signal) => {
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  })
  renderGuest()
  await userEvent.type(screen.getByRole('textbox', { name:'Message Swico' }), 'hello')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(screen.getByRole('button', { name:'Stop generation' })).toBeInTheDocument())
  await userEvent.click(screen.getByRole('button', { name:'Stop generation' }))
  await waitFor(() => expect(cancelGuestChatRequest).toHaveBeenCalledWith(guestSession.guest_token, expect.any(String)))
})

it('refreshes an expired stored token only once', async () => {
  vi.mocked(getStoredGuestToken).mockReturnValue('o'.repeat(64))
  vi.mocked(streamGuestChat)
    .mockRejectedValueOnce(new ApiError(401, { detail: 'Guest session expired.' }))
    .mockImplementationOnce(async (_token, _payload, onEvent) => {
      onEvent({ event:'delta', data:{ text:'Recovered' } })
      onEvent({ event:'done', data:{ thread_id:'thread-1', message_id:'message-1' } })
    })
  renderGuest()
  await userEvent.type(screen.getByRole('textbox', { name:'Message Swico' }), 'hello')
  await userEvent.click(screen.getByRole('button', { name:'Send message' }))
  await waitFor(() => expect(screen.getByText('Recovered')).toBeInTheDocument())
  expect(clearStoredGuestToken).toHaveBeenCalledOnce()
  expect(createGuestSession).toHaveBeenCalledOnce()
  expect(streamGuestChat).toHaveBeenCalledTimes(2)
})
