import {
  assertUsableTokenCredits, deleteGeneratedKnowledgeDocument,
  deleteGeneratedRepository, deleteGeneratedThread, deleteGeneratedUpload,
  productionRequestViolation, restoreProfile, restoreUsagePreferences,
  waitForDeployedWorkspace,
  type ApiResult, type DeployedApi, type RestorableProfile, type RestorableUsagePreferences,
} from './deployedSafety'
import type { Page } from '@playwright/test'

function workspacePage(options: {
  composerVisible?: boolean
  composerEnabled?: boolean
  textboxVisible?: boolean
  textboxEnabled?: boolean
} = {}): Page {
  const locator = (
    visible: boolean,
    enabled: boolean,
  ) => ({
    waitFor: vi.fn(() => visible
      ? Promise.resolve() : Promise.reject(new Error('not visible'))),
    isEnabled:vi.fn(() => Promise.resolve(enabled)),
  })
  const composer = locator(
    options.composerVisible ?? true,
    options.composerEnabled ?? true,
  )
  const textbox = locator(
    options.textboxVisible ?? true,
    options.textboxEnabled ?? true,
  )
  return {
    getByTestId:vi.fn((testId: string) => {
      if (testId !== 'composer') throw new Error('unexpected test id')
      return composer
    }),
    getByRole:vi.fn((role: string, details?: { name?: string }) => {
      if (role !== 'textbox' || details?.name !== 'Message Swico') {
        throw new Error('conditional action queried')
      }
      return textbox
    }),
  } as unknown as Page
}

class FakeApi implements DeployedApi {
  profile: RestorableProfile = { name:'changed', place:null, timezone:'UTC', assistant_name:'Bot', reply_language:'en' }
  usage: RestorableUsagePreferences = { period:'monthly', hard_limit_micros:null, warning_threshold_percent:99, notify_at_threshold:false }
  threads = new Set(['existing-thread', 'generated-thread'])
  knowledge = new Set(['existing-knowledge', 'generated-knowledge'])
  repositories = new Set(['generated-repository'])
  uploads = new Set(['generated-upload'])

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
    if (path === '/api/web/settings/profile') {
      if (method === 'PATCH') this.profile = { ...(body as RestorableProfile) }
      return { status:200, data:this.profile as T }
    }
    if (path === '/api/web/settings/usage') {
      if (method === 'PATCH') this.usage = { ...(body as RestorableUsagePreferences) }
      return { status:200, data:this.usage as T }
    }
    if (path.startsWith('/api/web/knowledge/')) {
      const id = decodeURIComponent(path.split('/').at(-1) ?? '')
      if (method === 'DELETE') { this.knowledge.delete(id); return { status:204, data:null } }
      return { status:this.knowledge.has(id) ? 200 : 404, data:null }
    }
    if (path.startsWith('/api/web/repositories/')) {
      const id = decodeURIComponent(path.split('/').at(-1) ?? '')
      if (method === 'DELETE') { this.repositories.delete(id); return { status:204, data:null } }
    }
    if (path.startsWith('/api/web/uploads/')) {
      const id = decodeURIComponent(path.split('/').at(-1) ?? '')
      if (method === 'DELETE') { this.uploads.delete(id); return { status:204, data:null } }
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

test('production cleanup protects existing knowledge and removes generated resources', async () => {
  const api = new FakeApi()
  await deleteGeneratedKnowledgeDocument(
    api, 'generated-knowledge', new Set(['existing-knowledge']),
  )
  await deleteGeneratedRepository(api, 'generated-repository')
  await deleteGeneratedUpload(api, 'generated-upload')
  expect([...api.knowledge]).toEqual(['existing-knowledge'])
  expect(api.repositories.size).toBe(0)
  expect(api.uploads.size).toBe(0)
  await expect(deleteGeneratedKnowledgeDocument(
    api, 'existing-knowledge', new Set(['existing-knowledge']),
  )).rejects.toThrow('pre-existing')
})

test('empty token balance produces a clear preflight failure', () => {
  expect(() => assertUsableTokenCredits(0)).toThrow('supervised Razorpay Test Mode transaction')
})

test('empty composer stable markers are ready without a Send message button', async () => {
  const page = workspacePage()
  await expect(waitForDeployedWorkspace(page, 100)).resolves.toBeUndefined()
  expect(page.getByTestId).toHaveBeenCalledWith('composer')
  expect(page.getByRole).toHaveBeenCalledWith(
    'textbox', { name:'Message Swico' },
  )
})

test('missing composer fails deployed workspace readiness safely', async () => {
  const page = workspacePage({ composerVisible:false })
  await expect(waitForDeployedWorkspace(page, 100)).rejects.toThrow()
})
