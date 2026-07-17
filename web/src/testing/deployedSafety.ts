export type ApiResult<T> = { status: number; data: T | null }

export interface DeployedApi {
  request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>>
}

export function assertUsableTokenCredits(availableMicros: number): void {
  if (!Number.isFinite(availableMicros) || availableMicros <= 0) {
    throw new Error(
      'Staging E2E requires usable token credits. Fund the dedicated staging account once with a supervised Razorpay Test Mode transaction; this test never automates payment.',
    )
  }
}

export type RestorableProfile = {
  name: string
  place: string | null
  timezone: string
  assistant_name: string
  reply_language: 'en' | 'ta'
}

export type RestorableUsagePreferences = {
  period: 'monthly'
  hard_limit_micros: number | null
  warning_threshold_percent: number
  notify_at_threshold: boolean
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const FORBIDDEN_PRODUCTION_PATHS = new Set([
  '/api/web/billing/orders',
  '/api/web/billing/verify',
  '/api/web/chat/stream',
])

export function productionRequestViolation(rawUrl: string, method: string): string | null {
  let path: string
  try { path = new URL(rawUrl).pathname }
  catch { return null }
  if (path !== '/api/web' && !path.startsWith('/api/web/')) return null
  if (FORBIDDEN_PRODUCTION_PATHS.has(path)) return `${method.toUpperCase()} ${path}`
  return MUTATING_METHODS.has(method.toUpperCase()) ? `${method.toUpperCase()} ${path}` : null
}

function sameFields<T extends object>(actual: T, expected: T, fields: Array<keyof T>) {
  return fields.every(field => actual[field] === expected[field])
}

export async function restoreProfile(api: DeployedApi, original: RestorableProfile): Promise<void> {
  const payload: RestorableProfile = {
    name: original.name,
    place: original.place,
    timezone: original.timezone,
    assistant_name: original.assistant_name,
    reply_language: original.reply_language,
  }
  const restored = await api.request<RestorableProfile>('PATCH', '/api/web/settings/profile', payload)
  if (restored.status !== 200) throw new Error('profile cleanup request failed')
  const verified = await api.request<RestorableProfile>('GET', '/api/web/settings/profile')
  const fields: Array<keyof RestorableProfile> = ['name', 'place', 'timezone', 'assistant_name', 'reply_language']
  if (verified.status !== 200 || !verified.data || !sameFields(verified.data, original, fields)) {
    throw new Error('profile cleanup verification failed')
  }
}

export async function restoreUsagePreferences(api: DeployedApi, original: RestorableUsagePreferences): Promise<void> {
  const payload: RestorableUsagePreferences = {
    period: original.period,
    hard_limit_micros: original.hard_limit_micros,
    warning_threshold_percent: original.warning_threshold_percent,
    notify_at_threshold: original.notify_at_threshold,
  }
  const restored = await api.request<RestorableUsagePreferences>('PATCH', '/api/web/settings/usage', payload)
  if (restored.status !== 200) throw new Error('usage-preference cleanup request failed')
  const verified = await api.request<RestorableUsagePreferences>('GET', '/api/web/settings/usage')
  const fields: Array<keyof RestorableUsagePreferences> = [
    'period', 'hard_limit_micros', 'warning_threshold_percent', 'notify_at_threshold',
  ]
  if (verified.status !== 200 || !verified.data || !sameFields(verified.data, original, fields)) {
    throw new Error('usage-preference cleanup verification failed')
  }
}

export async function deleteGeneratedThread(
  api: DeployedApi,
  generatedThreadId: string,
  originalThreadIds: ReadonlySet<string>,
): Promise<void> {
  if (originalThreadIds.has(generatedThreadId)) throw new Error('refusing to delete a pre-existing thread')
  const deleted = await api.request<never>('DELETE', `/api/web/threads/${encodeURIComponent(generatedThreadId)}`)
  if (deleted.status !== 204) throw new Error('E2E thread cleanup request failed')
  const verified = await api.request<unknown>('GET', `/api/web/threads/${encodeURIComponent(generatedThreadId)}`)
  if (verified.status !== 404) throw new Error('E2E thread cleanup verification failed')
}
