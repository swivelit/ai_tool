import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError, listCliSessions, revokeCliSession } from '../api/client'
import { TerminalSessions } from './TerminalSessions'

vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return { ...actual, listCliSessions: vi.fn(), revokeCliSession: vi.fn() }
})

const session = { id:'terminal-123456789', device_description:'Mac Terminal', created_at:'2026-09-12T10:00:00Z', last_seen_at:'2026-09-13T10:00:00Z' }
const otherSession = { ...session, id:'terminal-987654321', device_description:'Other Terminal' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.mocked(listCliSessions).mockResolvedValue({ items:[session] })
  vi.mocked(revokeCliSession).mockResolvedValue({ status:'revoked' })
})

it('renders safe session identity and confirms revoke before updating the list', async () => {
  render(<MemoryRouter><TerminalSessions user={{} as never} /></MemoryRouter>)
  expect(await screen.findByText('Mac Terminal')).toBeInTheDocument()
  expect(screen.getByText('terminal-123456789')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Revoke' }))
  expect(screen.getByRole('group', { name:/Confirm revocation/ })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name:'Confirm revoke' }))
  await waitFor(() => expect(revokeCliSession).toHaveBeenCalledWith(expect.anything(), 'terminal-123456789'))
  await waitFor(() => expect(screen.queryByText('Mac Terminal')).not.toBeInTheDocument())
  expect(screen.getByText(/was revoked/)).toBeInTheDocument()
})

it('keeps a session visible when revoke fails and offers retry for loading failures', async () => {
  vi.mocked(revokeCliSession).mockRejectedValueOnce(new ApiError(503, { detail:'Temporary failure' }))
  render(<MemoryRouter><TerminalSessions user={{} as never} /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name:'Revoke' }))
  await userEvent.click(screen.getByRole('button', { name:'Confirm revoke' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Temporary failure')
  expect(screen.getByText('Mac Terminal')).toBeInTheDocument()
  vi.mocked(listCliSessions).mockRejectedValueOnce(new Error('load failed'))
  await userEvent.click(screen.getByRole('button', { name:'Retry' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('load failed')
})

it('shows an explicit empty state', async () => {
  vi.mocked(listCliSessions).mockResolvedValueOnce({ items:[] })
  render(<MemoryRouter><TerminalSessions user={{} as never} /></MemoryRouter>)
  expect(await screen.findByText('No active terminal sessions.')).toBeInTheDocument()
})

it('does not render or announce results from a previous account after account change', async () => {
  const first = deferred<{ items: typeof session[] }>()
  const second = deferred<{ items: typeof otherSession[] }>()
  vi.mocked(listCliSessions).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const firstUser = { uid:'first-account' } as never
  const secondUser = { uid:'second-account' } as never
  const { rerender } = render(<MemoryRouter><TerminalSessions user={firstUser} /></MemoryRouter>)
  rerender(<MemoryRouter><TerminalSessions user={secondUser} /></MemoryRouter>)
  first.resolve({ items:[session] })
  second.resolve({ items:[otherSession] })
  expect(await screen.findByText('Other Terminal')).toBeInTheDocument()
  expect(screen.queryByText('Mac Terminal')).not.toBeInTheDocument()
  expect(screen.queryByText(/was revoked/)).not.toBeInTheDocument()
})

it('does not show a stale revoke success after the account changes while revoke is pending', async () => {
  const revokeRequest = deferred<{ status: string }>()
  vi.mocked(revokeCliSession).mockImplementationOnce(() => revokeRequest.promise)
  const firstUser = { uid:'first-account' } as never
  const secondUser = { uid:'second-account' } as never
  const { rerender } = render(<MemoryRouter><TerminalSessions user={firstUser} /></MemoryRouter>)
  await screen.findByText('Mac Terminal')
  await userEvent.click(screen.getByRole('button', { name:'Revoke' }))
  await userEvent.click(screen.getByRole('button', { name:'Confirm revoke' }))
  rerender(<MemoryRouter><TerminalSessions user={secondUser} /></MemoryRouter>)
  revokeRequest.resolve({ status:'revoked' })
  expect(await screen.findByText('Mac Terminal')).not.toBeNull()
  expect(screen.queryByText(/was revoked/)).not.toBeInTheDocument()
})
