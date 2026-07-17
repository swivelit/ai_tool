import {
  assertUsableTokenCredits, deleteGeneratedThread, productionRequestViolation, restoreProfile, restoreUsagePreferences,
  type ApiResult, type DeployedApi, type RestorableProfile, type RestorableUsagePreferences,
} from './deployedSafety'

class FakeApi implements DeployedApi {
  profile: RestorableProfile = { name:'changed', place:null, timezone:'UTC', assistant_name:'Bot', reply_language:'en' }
  usage: RestorableUsagePreferences = { period:'monthly', hard_limit_micros:null, warning_threshold_percent:99, notify_at_threshold:false }
  threads = new Set(['existing-thread', 'generated-thread'])

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
    if (path === '/api/web/settings/profile') {
      if (method === 'PATCH') this.profile = { ...(body as RestorableProfile) }
      return { status:200, data:this.profile as T }
    }
    if (path === '/api/web/settings/usage') {
      if (method === 'PATCH') this.usage = { ...(body as RestorableUsagePreferences) }
      return { status:200, data:this.usage as T }
    }
    const threadId = decodeURIComponent(path.split('/').at(-1) ?? '')
    if (method === 'DELETE') { this.threads.delete(threadId); return { status:204, data:null } }
    return { status:this.threads.has(threadId) ? 200 : 404, data:null }
  }
}

test('production-readonly rejects Swico API mutations and sensitive endpoints', () => {
  expect(productionRequestViolation('https://api.example.test/api/web/settings/profile', 'PATCH')).toBe('PATCH /api/web/settings/profile')
  expect(productionRequestViolation('https://api.example.test/api/web/chat/stream', 'GET')).toBe('GET /api/web/chat/stream')
  expect(productionRequestViolation('https://identitytoolkit.googleapis.com/v1/accounts', 'POST')).toBeNull()
  expect(productionRequestViolation('https://api.example.test/api/web/bootstrap', 'GET')).toBeNull()
  expect(productionRequestViolation('https://api.example.test/api/webhook', 'POST')).toBeNull()
})

test('staging cleanup restores every mutable profile field', async () => {
  const api = new FakeApi()
  const original = { name:'original', place:'Test place', timezone:'Asia/Kolkata', assistant_name:'Assistant', reply_language:'ta' as const }
  await restoreProfile(api, original)
  expect(api.profile).toEqual(original)
})

test('staging cleanup restores all original usage settings', async () => {
  const api = new FakeApi()
  const original = { period:'monthly' as const, hard_limit_micros:123_456, warning_threshold_percent:42, notify_at_threshold:true }
  await restoreUsagePreferences(api, original)
  expect(api.usage).toEqual(original)
})

test('staging cleanup deletes only the generated E2E thread', async () => {
  const api = new FakeApi()
  await deleteGeneratedThread(api, 'generated-thread', new Set(['existing-thread']))
  expect([...api.threads]).toEqual(['existing-thread'])
  await expect(deleteGeneratedThread(api, 'existing-thread', new Set(['existing-thread']))).rejects.toThrow('pre-existing')
})

test('empty token balance produces a clear preflight failure', () => {
  expect(() => assertUsableTokenCredits(0)).toThrow('supervised Razorpay Test Mode transaction')
})
