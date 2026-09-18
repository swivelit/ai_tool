import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VideoCard } from './VideoCard'

const mock = vi.hoisted(() => ({ api: vi.fn(), user: { uid: 'owner', getIdToken: vi.fn().mockResolvedValue('test-token-not-real') } }))
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: mock.user }) }))
vi.mock('../api/client', () => ({ API_BASE: '', apiJson: mock.api }))
const job = { id: 'job1', template_id: 'couple-01', state: 'ready', phase: 'ready', progress: 100, error: '', funding: 'paid', thread_id: 'thread1', expires_at: '', queue_position: null, eta_seconds: null, paused: false, refund_status: null }
beforeEach(() => {
  mock.api.mockReset()
  mock.api.mockResolvedValue({ ...job, expires_at: new Date(Date.now() + 600_000).toISOString() })
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:private'), configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('fetches private media with a header, never a token URL, and revokes on unmount', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['fixture'], { type: 'video/mp4' }) })
  vi.stubGlobal('fetch', fetcher)
  const view = render(<VideoCard jobId="job1" />)
  fireEvent.click(await screen.findByText('Load private video'))
  await screen.findByText('Download MP4')
  expect(fetcher).toHaveBeenCalledWith('/api/web/videos/jobs/job1/media', expect.objectContaining({ headers: { Authorization: 'Bearer test-token-not-real' }, cache: 'no-store' }))
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private')
})

it('does not render HTML in failure messages and does not offer regeneration', async () => {
  mock.api.mockResolvedValue({ ...job, state: 'refund_pending', error: '<script>evil()</script>', refund_status: 'submitted' })
  render(<VideoCard jobId="job1" />)
  expect(await screen.findByText('<script>evil()</script>')).toBeInTheDocument()
  expect(document.querySelector('script')).toBeNull()
  expect(screen.queryByText('Load private video')).toBeNull()
  expect(screen.queryByLabelText('Regenerate answer')).toBeNull()
})

it('makes an expired result a tombstone', async () => {
  mock.api.mockResolvedValue({ ...job, state: 'expired', expires_at: new Date(Date.now() - 10).toISOString() })
  render(<VideoCard jobId="job1" />)
  expect(await screen.findByText(/Expired —/)).toBeInTheDocument()
  expect(screen.queryByText('Load private video')).toBeNull()
})

it('ignores a stale status response after switching jobs', async () => {
  let resolve!: (value: unknown) => void
  mock.api.mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue({ ...job, id: 'job2', state: 'failed', error: 'new job failure' })
  const view = render(<VideoCard jobId="job1" />)
  view.rerender(<VideoCard jobId="job2" />)
  await screen.findByText('new job failure')
  await act(async () => resolve(job))
  await waitFor(() => expect(screen.getByText('new job failure')).toBeInTheDocument())
})
