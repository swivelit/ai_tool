import { URL } from 'node:url'

export const DEFAULT_API_ORIGIN = 'https://ai-tool-rrau.onrender.com'

/** Normalize one origin before it is used for API requests or credential keys. */
export function normalizeApiOrigin(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const parsed = new URL(value.trim())
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Swico CLI API endpoint must be an origin without credentials, path, query or fragment.')
  }
  if (parsed.protocol !== 'https:' && !(local && env.SWICO_CLI_ALLOW_INSECURE_LOCAL === '1')) {
    throw new Error('Swico CLI requires an HTTPS API endpoint outside explicit local development.')
  }
  return parsed.origin
}

export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeApiOrigin(env.SWICO_API_BASE_URL ?? env.SWICO_API_URL ?? DEFAULT_API_ORIGIN, env)
}

export function cliApi(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${apiBaseUrl(env)}/api/cli/v1${path}`
}

export function credentialKey(env: NodeJS.ProcessEnv = process.env): string {
  return apiBaseUrl(env)
}
