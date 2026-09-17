import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { CloudTasksPage } from './CloudTasksPage'

const { mocks, mockUser } = vi.hoisted(() => ({
  mocks: {
    listCloudJobs: vi.fn(), createCloudJob: vi.fn(), getCloudJob: vi.fn(),
    listCloudJobEvents: vi.fn(), cancelCloudJob: vi.fn(),
  },
  mockUser: { uid: 'cloud-test-user', getIdToken: vi.fn(async () => 'test-token') },
}))

vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }))
vi.mock('../api/client', () => ({ ...mocks }))

const job = (id: string, status = 'completed') => ({
  id, source: 'task_only', tier: 'lite', task: `task ${id}`, status,
  created_at: '2026-09-17T00:00:00Z', expires_at: '2026-09-17T01:00:00Z', attempt: 0,
  result: {}, failure_code: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listCloudJobs.mockResolvedValue({ items: [job('one'), job('two')] })
  mocks.listCloudJobEvents.mockResolvedValue({ job_id: 'one', items: [{ sequence: 0, event_type: 'one-event', payload: {}, created_at: '2026-09-17T00:00:00Z' }] })
})

it('ignores stale event responses after switching the selected job', async () => {
  const user = userEvent.setup()
  let releaseFirst!: (value: { job_id: string; items: never[] }) => void
  mocks.listCloudJobEvents.mockImplementation((_account, id: string) => id === 'one'
    ? new Promise(resolve => { releaseFirst = resolve })
    : Promise.resolve({ job_id: 'two', items: [{ sequence: 0, event_type: 'two-event', payload: {}, created_at: '2026-09-17T00:00:00Z' }] }))
  render(<MemoryRouter><CloudTasksPage /></MemoryRouter>)
  await waitFor(() => expect(screen.getByRole('button', { name: /task one/i })).toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: /task one/i }))
  await user.click(screen.getByRole('button', { name: /task two/i }))
  expect(await screen.findByText(/two-event/)).toBeInTheDocument()
  releaseFirst({ job_id: 'one', items: [] })
  await waitFor(() => expect(screen.queryByText(/one-event/)).not.toBeInTheDocument())
})

it('requires consent and sends one stable request id for a retryable submission', async () => {
  const user = userEvent.setup()
  mocks.listCloudJobs.mockResolvedValue({ items: [] })
  mocks.createCloudJob.mockResolvedValue(job('new', 'queued'))
  render(<MemoryRouter><CloudTasksPage /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText(/No tasks yet/)).toBeInTheDocument())
  const task = screen.getByLabelText('Task description')
  await user.type(task, 'inspect repository')
  const submit = screen.getByRole('button', { name: 'Start task' })
  expect(submit).toBeDisabled()
  await user.click(screen.getByRole('checkbox'))
  expect(submit).toBeEnabled()
  await user.click(submit)
  await waitFor(() => expect(mocks.createCloudJob).toHaveBeenCalledTimes(1))
  expect(mocks.createCloudJob.mock.calls[0][1]).toBe('inspect repository')
  expect(mocks.createCloudJob.mock.calls[0][2]).toMatch(/^[0-9a-f-]{36}$/)
})
