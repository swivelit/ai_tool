import { URL } from 'node:url'

export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SWICO_API_BASE_URL ?? env.SWICO_API_URL ?? 'https://swico.in'
  const parsed = new URL(value)
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !(local && env.SWICO_CLI_ALLOW_INSECURE_LOCAL === '1')) {
    throw new Error('Swico CLI requires an HTTPS API endpoint outside explicit local development.')
  }
  return value.replace(/\/$/, '')
}

export function cliApi(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${apiBaseUrl(env)}/api/cli/v1${path}`
}
