import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { LoginPage } from './LoginPage'

const auth = { signIn: vi.fn(), signUp: vi.fn(), resetPassword: vi.fn(), resendSignUp: vi.fn(), resendPasswordReset: vi.fn(), signOut: vi.fn(), user:null, loading:false }
vi.mock('../auth/useAuth', () => ({ useAuth: () => auth }))

it('supports password visibility and prevents repeat submission while busy', async () => {
  let resolve!: () => void; auth.signIn.mockReturnValue(new Promise<void>(done => { resolve = done }))
  render(<LoginPage />)
  await userEvent.type(screen.getByLabelText('Email address'), 'user@example.com')
  await userEvent.type(screen.getByLabelText('Password'), 'password1')
  await userEvent.click(screen.getByRole('button', { name:'Show password' })); expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
  await userEvent.click(screen.getByRole('button', { name:'Sign in' })); expect(screen.getByRole('button', { name:'Please wait…' })).toBeDisabled()
  fireEvent.submit(screen.getByRole('button', { name:'Please wait…' }).closest('form')!); expect(auth.signIn).toHaveBeenCalledOnce(); await act(async () => resolve())
})

it('validates OTP length and preserves the email in signup verification state', async () => {
  auth.signUp.mockResolvedValue({ status: 'otp_sent', cooldownSeconds: 42 })
  render(<LoginPage />); await userEvent.click(screen.getByText('Create account'))
  await userEvent.type(screen.getByLabelText('Name'), 'Hari'); await userEvent.type(screen.getByLabelText('Email address'), 'hari@example.com'); await userEvent.type(screen.getByLabelText('Password'), 'password1')
  await userEvent.click(screen.getByRole('button', { name:'Continue' }))
  expect(await screen.findByLabelText('Verification code')).toBeInTheDocument(); expect(screen.getByLabelText('Email address')).toBeDisabled(); expect(screen.getByLabelText('Email address')).toHaveValue('hari@example.com')
  await userEvent.type(screen.getByLabelText('Verification code'), '123')
  await userEvent.click(screen.getByRole('button', { name:'Verify and create account' })); expect(screen.getByRole('alert')).toHaveTextContent('6-digit')
})

it('shows a server-driven resend countdown and clears the code after signup resend', async () => {
  vi.useFakeTimers()
  try {
    auth.signUp.mockResolvedValue({ status: 'otp_sent', cooldownSeconds: 2 })
    auth.resendSignUp.mockResolvedValue(7)
    render(<LoginPage initialMode="signup" />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic User' } })
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'synthetic@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await act(async () => undefined)
    expect(screen.getByRole('button', { name: 'Resend code in 2 seconds' })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Resend code' }))
    await act(async () => undefined)
    expect(auth.resendSignUp).toHaveBeenCalledWith('Synthetic User', 'synthetic@example.test')
    expect(screen.getByLabelText('Verification code')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Resend code in 7 seconds' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('A new verification code was sent.')
  } finally {
    vi.useRealTimers()
  }
})

it('shows resend after an expired reset OTP', async () => {
  auth.resetPassword.mockResolvedValue({ status: 'otp_sent', cooldownSeconds: 0 })
  auth.resendPasswordReset.mockResolvedValue(0)
  render(<LoginPage initialMode="reset" />)

  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: 'reset@example.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send verification code' }))
  await act(async () => undefined)

  expect(screen.queryByRole('button', { name: 'Resend code' })).not.toBeInTheDocument()

  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: 'newpassword' },
  })
  fireEvent.change(screen.getByLabelText('Verification code'), {
    target: { value: '123456' },
  })

  const error = new Error('This code is invalid or expired. Request a new code.')
  error.name = 'otp_invalid_or_expired'
  auth.resetPassword.mockRejectedValueOnce(error)

  fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  await act(async () => undefined)

  expect(screen.getByRole('button', { name: 'Resend code' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Resend code' }))
  await act(async () => undefined)

  expect(auth.resendPasswordReset).toHaveBeenCalledWith('reset@example.test')
  expect(screen.getByLabelText('Verification code')).toHaveValue('')
  expect(screen.getByRole('status')).toHaveTextContent(
    'A new verification code was sent.',
  )
  expect(screen.getByLabelText('New password')).toHaveValue('newpassword')
})

it('returns to sign in after a successful password reset', async () => {
  auth.resetPassword
    .mockResolvedValueOnce({ status: 'otp_sent', cooldownSeconds: 0 })
    .mockResolvedValueOnce({ status: 'complete' })
  render(<LoginPage initialMode="reset" />)
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'success@example.test' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send verification code' }))
  await act(async () => undefined)
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpassword' } })
  fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } })
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  await act(async () => undefined)
  expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Password changed.')
})
