export const PUBLIC_WEB_CONFIG_VARIABLES = [
  'VITE_API_BASE_URL',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
] as const

type PublicWebConfigVariable = (typeof PUBLIC_WEB_CONFIG_VARIABLES)[number]
type PublicWebEnvironment = 'production' | 'development' | 'test'
type PublicWebEnv = Partial<Record<PublicWebConfigVariable, string | undefined>>

export interface PublicWebConfig {
  apiBaseUrl: string
  firebase: {
    apiKey: string
    authDomain: string
    projectId: string
    appId: string
    messagingSenderId: string
  }
}

export class PublicWebConfigError extends Error {
  constructor(public readonly failures: ReadonlyArray<{ variable: PublicWebConfigVariable; reason: string }>) {
    super(`Invalid public web configuration:\n${failures.map(({ variable, reason }) => `- ${variable}: ${reason}`).join('\n')}`)
    this.name = 'PublicWebConfigError'
  }
}

function isValidAuthDomain(value: string): boolean {
  if (/[\s/@?#]/.test(value)) return false
  try {
    const url = new URL(`https://${value}`)
    return Boolean(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  } catch {
    return false
  }
}

export function validatePublicWebConfig(
  env: PublicWebEnv,
  environment: PublicWebEnvironment,
): PublicWebConfig {
  const values = Object.fromEntries(
    PUBLIC_WEB_CONFIG_VARIABLES.map(variable => [variable, env[variable]?.trim() ?? '']),
  ) as Record<PublicWebConfigVariable, string>
  const failures: Array<{ variable: PublicWebConfigVariable; reason: string }> = []

  for (const variable of PUBLIC_WEB_CONFIG_VARIABLES) {
    if (!values[variable]) failures.push({ variable, reason: 'is required and cannot be blank' })
  }

  if (values.VITE_API_BASE_URL) {
    try {
      const url = new URL(values.VITE_API_BASE_URL)
      const isHttps = url.protocol === 'https:'
      const isLocalHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
      const hasExplicitHttpScheme = /^https?:\/\//.test(values.VITE_API_BASE_URL)
      if (!hasExplicitHttpScheme || url.username || url.password || (!isHttps && !(environment !== 'production' && isLocalHttp))) {
        failures.push({
          variable: 'VITE_API_BASE_URL',
          reason: environment === 'production' ? 'must be an absolute HTTPS URL' : 'must be an absolute HTTPS URL or a localhost HTTP URL',
        })
      }
    } catch {
      failures.push({ variable: 'VITE_API_BASE_URL', reason: 'must be an absolute URL' })
    }
  }

  if (values.VITE_FIREBASE_AUTH_DOMAIN && !isValidAuthDomain(values.VITE_FIREBASE_AUTH_DOMAIN)) {
    failures.push({ variable: 'VITE_FIREBASE_AUTH_DOMAIN', reason: 'must be a valid URL-compatible host' })
  }

  if (environment === 'production' && values.VITE_FIREBASE_APP_ID && !values.VITE_FIREBASE_APP_ID.includes(':web:')) {
    failures.push({ variable: 'VITE_FIREBASE_APP_ID', reason: 'must be a Firebase Web app ID containing ":web:"' })
  }

  if (failures.length) throw new PublicWebConfigError(failures)

  return {
    apiBaseUrl: values.VITE_API_BASE_URL,
    firebase: {
      apiKey: values.VITE_FIREBASE_API_KEY,
      authDomain: values.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: values.VITE_FIREBASE_PROJECT_ID,
      appId: values.VITE_FIREBASE_APP_ID,
      messagingSenderId: values.VITE_FIREBASE_MESSAGING_SENDER_ID,
    },
  }
}
