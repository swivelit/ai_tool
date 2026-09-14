import { MemoryRouter } from 'react-router-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { User } from 'firebase/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CliAuthorizePage } from './CliAuthorizePage'

const mocks = vi.hoisted(() => ({
  auth: { user: null as User | null, loading: false, signIn: vi.fn(), signUp: vi.fn(), resetPassword: vi.fn(), signOut: vi.fn() },
  getCliDeviceInfo: vi.fn(),
  approveCliDevice: vi.fn(),
}))
const { auth, getCliDeviceInfo, approveCliDevice } = mocks

vi.mock('../auth/useAuth', () => ({ useAuth: () => mocks.auth }))
vi.mock('../api/client', () => ({ getCliDeviceInfo: mocks.getCliDeviceInfo, approveCliDevice: mocks.approveCliDevice }))

function renderAuthorize(path = '/cli/authorize?user_code=sw-123') {
  return render(<MemoryRouter initialEntries={[path]}><CliAuthorizePage /></MemoryRouter>)
}

const pendingDevice = { user_code: 'SW-123', device_description: 'Test terminal', scopes: ['chat'], tier: 'standard' as const, status: 'pending', expires_at: '2099-01-01T00:00:00Z' }

beforeEach(() => {
  auth.user = null
  getCliDeviceInfo.mockReset()
  approveCliDevice.mockReset()
})

it('preserves the signed-out authorization return route and code', () => {
  getCliDeviceInfo.mockResolvedValue(pendingDevice)
  renderAuthorize()
  const link = screen.getByRole('link', { name: 'Sign in' })
  expect(link).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent('/cli/authorize?user_code=SW-123')}`)
  expect(screen.getByText('Code:')).toBeInTheDocument()
})

describe('authenticated paid authorization', () => {
  beforeEach(() => {
    auth.user = { uid: 'owner', getIdToken: vi.fn() } as unknown as User
    getCliDeviceInfo.mockResolvedValue(pendingDevice)
  })

  it('shows the explicit paid tier and sends an approval decision', async () => {
    approveCliDevice.mockResolvedValue({ status: 'approved' })
    renderAuthorize()
    expect(await screen.findByText(/Selected CLI tier:/)).toHaveTextContent('standard')
    await userEvent.click(screen.getByRole('button', { name: 'Approve terminal' }))
    await waitFor(() => expect(approveCliDevice).toHaveBeenCalledWith(auth.user, 'SW-123', true))
    expect(screen.getByRole('status')).toHaveTextContent('approved')
  })

  it('sends denial and does not present it as approval', async () => {
    approveCliDevice.mockResolvedValue({ status: 'denied' })
    renderAuthorize()
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(approveCliDevice).toHaveBeenCalledWith(auth.user, 'SW-123', false))
    expect(screen.getByRole('status')).toHaveTextContent('denied')
  })

  it('renders expired or wrong-account responses as unavailable without approval controls', async () => {
    getCliDeviceInfo.mockResolvedValueOnce({ ...pendingDevice, status: 'expired' })
    const { unmount } = renderAuthorize()
    expect(await screen.findByRole('status')).toHaveTextContent('expired')
    expect(screen.queryByRole('button', { name: 'Approve terminal' })).not.toBeInTheDocument()
    unmount()
    getCliDeviceInfo.mockRejectedValueOnce(new Error('request unavailable'))
    renderAuthorize('/cli/authorize?user_code=forged-free')
    expect(await screen.findByRole('status')).toHaveTextContent('expired or unavailable')
    expect(approveCliDevice).not.toHaveBeenCalled()
  })
})
