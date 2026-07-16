import { PublicWebConfigError, validatePublicWebConfig } from './publicWebConfig'

const validProductionEnv = {
  VITE_API_BASE_URL: 'https://api.example.test',
  VITE_FIREBASE_API_KEY: 'public-test-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'swico-test.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'swico-test',
  VITE_FIREBASE_APP_ID: '1:1234567890:web:abcdef123456',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '1234567890',
}

function validationMessage(env: Partial<typeof validProductionEnv>, environment: 'production' | 'development' | 'test' = 'production') {
  try {
    validatePublicWebConfig(env, environment)
    throw new Error('Expected public web configuration validation to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(PublicWebConfigError)
    return (error as Error).message
  }
}

it('accepts a valid production Firebase Web configuration', () => {
  expect(validatePublicWebConfig(validProductionEnv, 'production')).toEqual({
    apiBaseUrl: validProductionEnv.VITE_API_BASE_URL,
    firebase: {
      apiKey: validProductionEnv.VITE_FIREBASE_API_KEY,
      authDomain: validProductionEnv.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: validProductionEnv.VITE_FIREBASE_PROJECT_ID,
      appId: validProductionEnv.VITE_FIREBASE_APP_ID,
      messagingSenderId: validProductionEnv.VITE_FIREBASE_MESSAGING_SENDER_ID,
    },
  })
})

it('trims every public configuration value before returning it', () => {
  const config = validatePublicWebConfig(
    Object.fromEntries(Object.entries(validProductionEnv).map(([name, value]) => [name, `  ${value}  `])),
    'production',
  )

  expect(config.apiBaseUrl).toBe(validProductionEnv.VITE_API_BASE_URL)
  expect(config.firebase).toEqual({
    apiKey: validProductionEnv.VITE_FIREBASE_API_KEY,
    authDomain: validProductionEnv.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: validProductionEnv.VITE_FIREBASE_PROJECT_ID,
    appId: validProductionEnv.VITE_FIREBASE_APP_ID,
    messagingSenderId: validProductionEnv.VITE_FIREBASE_MESSAGING_SENDER_ID,
  })
})

it('rejects a missing required variable and identifies it by name', () => {
  const env = { ...validProductionEnv, VITE_FIREBASE_PROJECT_ID: undefined }
  expect(validationMessage(env)).toContain('VITE_FIREBASE_PROJECT_ID')
})

it('rejects an HTTP production API URL', () => {
  const message = validationMessage({ ...validProductionEnv, VITE_API_BASE_URL: 'http://api.example.test/private-path' })
  expect(message).toContain('VITE_API_BASE_URL')
  expect(message).toContain('HTTPS')
})

it.each(['development', 'test'] as const)('allows localhost HTTP in %s', environment => {
  expect(() => validatePublicWebConfig({ ...validProductionEnv, VITE_API_BASE_URL: 'http://localhost:8000' }, environment)).not.toThrow()
  expect(() => validatePublicWebConfig({ ...validProductionEnv, VITE_API_BASE_URL: 'http://127.0.0.1:4173' }, environment)).not.toThrow()
})

it('rejects an Android-style Firebase app ID in production', () => {
  const message = validationMessage({ ...validProductionEnv, VITE_FIREBASE_APP_ID: '1:1234567890:android:abcdef123456' })
  expect(message).toContain('VITE_FIREBASE_APP_ID')
  expect(message).toContain('Web app ID')
})

it('lists invalid variable names without including supplied values', () => {
  const suppliedValues = [
    'credential-user',
    'credential-password',
    'secret-api-key-value',
    'private-auth-domain/path',
    'android-secret-app-id',
  ]
  const message = validationMessage({
    ...validProductionEnv,
    VITE_API_BASE_URL: `https://${suppliedValues[0]}:${suppliedValues[1]}@api.example.test`,
    VITE_FIREBASE_API_KEY: suppliedValues[2],
    VITE_FIREBASE_AUTH_DOMAIN: suppliedValues[3],
    VITE_FIREBASE_APP_ID: suppliedValues[4],
  })

  expect(message).toContain('VITE_API_BASE_URL')
  expect(message).toContain('VITE_FIREBASE_AUTH_DOMAIN')
  expect(message).toContain('VITE_FIREBASE_APP_ID')
  for (const value of suppliedValues) expect(message).not.toContain(value)
})
