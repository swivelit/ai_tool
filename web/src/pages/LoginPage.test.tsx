import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { LoginPage } from './LoginPage'

const auth = { signIn: vi.fn(), signUp: vi.fn(), resetPassword: vi.fn(), signOut: vi.fn(), user:null, loading:false }
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
  auth.signUp.mockResolvedValue('otp_sent')
  render(<LoginPage />); await userEvent.click(screen.getByText('Create account'))
  await userEvent.type(screen.getByLabelText('Name'), 'Hari'); await userEvent.type(screen.getByLabelText('Email address'), 'hari@example.com'); await userEvent.type(screen.getByLabelText('Password'), 'password1')
  await userEvent.click(screen.getByRole('button', { name:'Continue' }))
  expect(await screen.findByLabelText('Verification code')).toBeInTheDocument(); expect(screen.getByLabelText('Email address')).toBeDisabled(); expect(screen.getByLabelText('Email address')).toHaveValue('hari@example.com')
  await userEvent.type(screen.getByLabelText('Verification code'), '123')
  await userEvent.click(screen.getByRole('button', { name:'Verify and create account' })); expect(screen.getByRole('alert')).toHaveTextContent('6-digit')
})
