import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { VideosPage } from './VideosPage'

const mock = vi.hoisted(() => ({ api: vi.fn(), user: { uid: 'owner' } }))
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: mock.user }) }))
vi.mock('../api/client', () => ({ API_BASE: '', apiJson: mock.api }))
vi.mock('../video/VideoCard', () => ({ VideoCard: ({ jobId }: { jobId: string }) => <div>Job {jobId}</div> }))
it('shows unavailable templates and does not allow checkout without preflight', async () => {
  mock.api.mockImplementation((_user: unknown, path: string) => Promise.resolve(path.endsWith('capabilities') ? { available: false, enabled: false, paid_enabled: false, price_paise: 2500, policy_version: 'v1', allowance: { unlimited: false, remaining: 0, reset_at: new Date().toISOString() }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: false }, { id: 'couple-02', title: 'Couple scene 2', available: false }] } : { items: [] }))
  render(<MemoryRouter><VideosPage /></MemoryRouter>)
  expect(await screen.findByText(/Video creation is paused/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Couple scene 1/ })).toBeDisabled()
  expect(screen.queryByText('Pay ₹25 total for this video')).toBeNull()
})

it('requires explicit consent and selected role uploads for Mac preflight', async () => {
  mock.api.mockImplementation((_user: unknown, path: string) => Promise.resolve(path.endsWith('capabilities') ? { available: true, enabled: true, paid_enabled: true, price_paise: 2500, policy_version: 'v1', consent_version: 'video-source-consent-2026-09-19', allowance: { unlimited: true, remaining: null, reset_at: new Date().toISOString() }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: true }] } : { items: [] }))
  render(<MemoryRouter><VideosPage /></MemoryRouter>)
  const button = await screen.findByText('Validate photos on Mac (no charge)')
  expect(button).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Male role photo'), { target: { files: [new File(['fixture'], 'photo.jpg', { type: 'image/jpeg' })] } })
  fireEvent.change(screen.getByLabelText('Female role photo'), { target: { files: [new File(['fixture'], 'photo2.jpg', { type: 'image/jpeg' })] } })
  expect(button).toBeDisabled()
  for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox)
  expect(button).toBeEnabled()
})

it('keeps an interrupted upload visible instead of hiding an outstanding request', async () => {
  mock.api.mockImplementation((_user: unknown, path: string, options?: RequestInit) => {
    if (path.endsWith('capabilities')) return Promise.resolve({ available: true, paid_enabled: false, policy_version: 'v1', allowance: { unlimited: true, remaining: null, reset_at: new Date().toISOString() }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: true }] })
    if (path.includes('/photos/')) return Promise.reject(new Error('Upload interrupted'))
    if (options?.method === 'POST') return Promise.resolve({ id: 'recoverable', state: 'uploading' })
    return Promise.resolve({ items: [] })
  })
  render(<MemoryRouter><VideosPage /></MemoryRouter>)
  const button = await screen.findByText('Validate photos on Mac (no charge)')
  for (const label of ['Male role photo', 'Female role photo']) fireEvent.change(screen.getByLabelText(label), { target: { files: [new File(['fixture'], 'photo.jpg', { type: 'image/jpeg' })] } })
  for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox)
  // jsdom does not populate the native file-input validity state from File arrays.
  fireEvent.submit(button.closest('form')!)
  expect(await screen.findByText('Upload interrupted')).toBeInTheDocument()
  expect(screen.getByText('Job recoverable')).toBeInTheDocument()
  expect(screen.queryByText('Pay ₹25 total for this video')).toBeNull()
})

it('restores an already validated request after reload without another upload or payment', async () => {
  mock.api.mockImplementation((_user: unknown, path: string) => Promise.resolve(path.endsWith('capabilities') ? { available: true, paid_enabled: false, policy_version: 'v1', allowance: { unlimited: true, remaining: null, reset_at: new Date().toISOString() }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: true }] } : { items: [{ id: 'resume-job', state: 'validated', options: { swap: 'male', enhance: 'off', caption: '' } }] }))
  render(<MemoryRouter><VideosPage /></MemoryRouter>)
  expect(await screen.findByText('Confirm supported edit')).toBeInTheDocument()
  expect(screen.getByText('Job resume-job')).toBeInTheDocument()
  expect(screen.getByText('Use complimentary attempt')).toBeEnabled()
})

it('keeps validated history visible but refuses purchase while worker setup is unavailable', async () => {
  mock.api.mockImplementation((_user: unknown, path: string) => Promise.resolve(path.endsWith('capabilities') ? { available: false, paid_enabled: true, policy_version: 'v1', allowance: { unlimited: true, reset_at: new Date().toISOString() }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: false }] } : { items: [{ id: 'paused-job', state: 'validated', options: { swap: 'male', enhance: 'off', caption: '' } }] }))
  render(<MemoryRouter><VideosPage /></MemoryRouter>)
  expect(await screen.findByText('Job paused-job')).toBeInTheDocument()
  expect(screen.getByText('Use complimentary attempt')).toBeDisabled()
  expect(screen.getByText('Pay ₹25 total for this video')).toBeDisabled()
})

it('offers resume for one existing checkout without creating a new request', async () => {
  const checkout = { id: 'checkout-job', state: 'checkout', phase: 'checkout', progress: 0, error: '', funding: 'paid', template_id: 'couple-01', options: { swap: 'male', enhance: 'off', caption: '' }, checkout_expires_at: new Date(Date.now() + 60_000).toISOString() }
  const calls: string[] = []
  mock.api.mockImplementation((_user: unknown, path: string, options?: RequestInit) => {
    calls.push(`${options?.method ?? 'GET'} ${path}`)
    if (path.endsWith('capabilities')) return Promise.resolve({ available: false, paid_enabled: true, paid_available: false, policy_version: 'v1', consent_version: 'fixture', allowance: { unlimited: false, remaining: 0, reset_at: new Date().toISOString() }, templates: [] })
    if (path.endsWith('/admit')) return Promise.resolve({ job: checkout, checkout: null })
    return Promise.resolve({ items: [checkout] })
  })
  render(<MemoryRouter><VideosPage /></MemoryRouter>)
  expect(await screen.findByRole('button', { name: 'Resume payment' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Resume payment' }))
  await waitFor(() => expect(calls.filter(value => value.includes('/admit')).length).toBe(1))
  expect(calls.filter(value => value === 'POST /api/web/videos/jobs').length).toBe(0)
})

it('clears a role photo when an invalid replacement is selected', async () => {
  mock.api.mockImplementation((_user: unknown, path: string) => Promise.resolve(path.endsWith('capabilities') ? { available: true, enabled: true, paid_enabled: false, policy_version: 'v1', consent_version: 'fixture', allowance: { unlimited: true, remaining: null, reset_at: new Date().toISOString() }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: true }] } : { items: [] }))
  render(<MemoryRouter><VideosPage /></MemoryRouter>)
  const input = await screen.findByLabelText('Male role photo') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['ok'], 'photo.jpg', { type: 'image/jpeg' })] } })
  expect(input.files).toHaveLength(1)
  fireEvent.change(input, { target: { files: [] } })
  expect(input).toBeInvalid()
  expect(screen.getByText(/non-empty JPEG/)).toBeInTheDocument()
})

it('supports explicit local photo removal before preflight', async () => {
  mock.api.mockImplementation((_user: unknown, path: string) => Promise.resolve(path.endsWith('capabilities') ? { available: true, enabled: true, paid_enabled: false, policy_version: 'v1', consent_version: 'fixture', allowance: { unlimited: true, remaining: null, reset_at: new Date().toISOString() }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: true }] } : { items: [] }))
  render(<MemoryRouter><VideosPage /></MemoryRouter>)
  const input = await screen.findByLabelText('Male role photo') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['ok'], 'photo.jpg', { type: 'image/jpeg' })] } })
  expect(await screen.findByRole('button', { name: 'Remove male photo' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove male photo' }))
  expect(screen.getByText('Validate photos on Mac (no charge)')).toBeDisabled()
})
