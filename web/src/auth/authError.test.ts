import { FirebaseError } from 'firebase/app'
import { ApiError, ApiNetworkError } from '../api/client'
import { authApiErrorMessage, friendlyAuthError } from './authError'

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  consoleError.mockRestore()
})

it.each(['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'])('maps %s to the invalid-credentials message', code => {
  expect(friendlyAuthError(new FirebaseError(code, 'Sensitive Firebase details'))).toBe('The email or password is incorrect.')
  expect(consoleError).toHaveBeenCalledWith('Firebase Authentication error', { code })
})

it.each([
  'auth/invalid-api-key',
  'auth/app-not-authorized',
  'auth/auth-domain-config-required',
  'auth/unauthorized-domain',
  'auth/operation-not-allowed',
])('maps deployment error %s to a configuration message', code => {
  expect(friendlyAuthError(new FirebaseError(code, 'Sensitive Firebase details'))).toBe(
    'Sign-in is unavailable because this deployment is not configured correctly.',
  )
})

it('maps throttling errors', () => {
  expect(friendlyAuthError(new FirebaseError('auth/too-many-requests', 'Sensitive Firebase details'))).toBe(
    'Too many attempts. Wait a moment, then try again.',
  )
})

it('maps network errors', () => {
  expect(friendlyAuthError(new FirebaseError('auth/network-request-failed', 'Sensitive Firebase details'))).toBe(
    'Check your connection and try again.',
  )
})

it('uses a generic message for an unknown Firebase error', () => {
  expect(friendlyAuthError(new FirebaseError('auth/unmapped-error', 'Sensitive Firebase details'))).toBe(
    'We could not complete that request. Please try again.',
  )
})

it('preserves an ordinary backend error message without logging it', () => {
  expect(friendlyAuthError(new Error('The verification code has expired.'))).toBe('The verification code has expired.')
  expect(consoleError).not.toHaveBeenCalled()
})

it('preserves known OTP API messages including cooldowns', () => {
  const error = new ApiError(429, {
    detail: {
      code: 'otp_cooldown',
      message: 'Please wait 42 seconds before requesting another code.',
    },
  })

  expect(authApiErrorMessage(error, true)).toBe(
    'Please wait 42 seconds before requesting another code.',
  )
})

it('hides unexpected backend details while requesting a code', () => {
  const error = new ApiError(500, { detail: 'sensitive implementation detail' })

  expect(authApiErrorMessage(error, true)).toBe(
    'We could not send the code. Please try again.',
  )
})

it('uses the safe server reachability message for network failures', () => {
  expect(authApiErrorMessage(new ApiNetworkError(), true)).toBe(
    'We could not reach the server. Please try again.',
  )
})
