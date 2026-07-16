import { FirebaseError } from 'firebase/app'

const INVALID_CREDENTIAL_CODES = new Set([
  'auth/invalid-credential',
  'auth/wrong-password',
  'auth/user-not-found',
])

const DEPLOYMENT_CONFIGURATION_CODES = new Set([
  'auth/invalid-api-key',
  'auth/app-not-authorized',
  'auth/auth-domain-config-required',
  'auth/unauthorized-domain',
  'auth/operation-not-allowed',
])

function safeFirebaseCode(code: string): string {
  return /^auth\/[a-z0-9-]+$/.test(code) ? code : 'auth/unknown'
}

export function friendlyAuthError(error: unknown): string {
  if (!(error instanceof FirebaseError)) {
    const message = error instanceof Error ? error.message : ''
    return message && !message.includes('Firebase') ? message : 'We could not complete that request. Please try again.'
  }

  const code = safeFirebaseCode(error.code)
  console.error('Firebase Authentication error', { code })

  if (INVALID_CREDENTIAL_CODES.has(code)) return 'The email or password is incorrect.'
  if (DEPLOYMENT_CONFIGURATION_CODES.has(code)) return 'Sign-in is unavailable because this deployment is not configured correctly.'
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a moment, then try again.'
  if (code === 'auth/network-request-failed') return 'Check your connection and try again.'
  if (code === 'auth/user-disabled') return 'This account is unavailable. Contact support for help.'
  if (code === 'auth/invalid-email') return 'Enter a valid email address.'
  return 'We could not complete that request. Please try again.'
}
