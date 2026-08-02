import {
  assertUsableTokenCredits, AuthenticatedDeployedApi,
  deleteGeneratedKnowledgeDocument,
  deleteGeneratedRepository, deleteGeneratedThread, deleteGeneratedUpload,
  isPostChatStreamRequest, isPostChatStreamResponse,
  observePlaywrightPromise, productionRequestViolation,
  restoreProfile, restoreUsagePreferences, runCleanupActionSafely,
  ThreadCleanupError,
  waitForDeployedWorkspace, writeFinalSafetyReports,
  type ApiResult, type DeployedApi, type RestorableProfile, type RestorableUsagePreferences,
} from './deployedSafety'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { APIRequestContext, Page, Request, Response } from '@playwright/test'

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

test('chat-stream Request matching uses Request.method directly', () => {
  const method = vi.fn(() => 'POST')
  const requestAccessor = vi.fn(() => {
    throw new Error('Request.request must not be called')
  })
  const request = {
    url:() => 'https://swico.example/api/web/chat/stream',
    method,
    request:requestAccessor,
  } as unknown as Request
  expect(isPostChatStreamRequest(request)).toBe(true)
  expect(method).toHaveBeenCalledOnce()
  expect(requestAccessor).not.toHaveBeenCalled()
})

test('chat-stream Response matching uses Response.request method', () => {
  const method = vi.fn(() => 'POST')
  const request = { method } as unknown as Request
  const requestAccessor = vi.fn(() => request)
  const response = {
    url:() => 'https://swico.example/api/web/chat/stream',
    request:requestAccessor,
  } as unknown as Response
  expect(isPostChatStreamResponse(response)).toBe(true)
  expect(requestAccessor).toHaveBeenCalledOnce()
  expect(method).toHaveBeenCalledOnce()
})

test('production capability workflows use typed chat observers only', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  for (const [observer, matcher] of [
    ['editRequestPromise', 'waitForRequest(isPostChatStreamRequest)'],
    ['editResponsePromise', 'waitForResponse(isPostChatStreamResponse)'],
    ['regenerateRequestPromise', 'waitForRequest(isPostChatStreamRequest)'],
    ['regenerateResponsePromise', 'waitForResponse(isPostChatStreamResponse)'],
    ['continuationRequestPromise', 'waitForRequest(isPostChatStreamRequest)'],
    ['continuationResponsePromise', 'waitForResponse(isPostChatStreamResponse)'],
  ]) {
    expect(spec).toContain(
      `const ${observer} = observePlaywrightPromise(page.${matcher})`,
    )
  }
  const cancellation = spec.slice(
    spec.indexOf('let cancellationRequestId'),
    spec.indexOf("workflowResults.push({ id:'J-DISCONNECT-RECOVERY'"),
  )
  expect(cancellation).toMatch(
    /requestPromise\s*=\s*observePlaywrightPromise\(page\.waitForRequest\(\s*isPostChatStreamRequest/,
  )
  expect(cancellation).toMatch(
    /cancellationTerminalResponse\s*=\s*observePlaywrightPromise\(page\.waitForResponse\(\s*isPostChatStreamResponse/,
  )
  const requestObservers = [...spec.matchAll(/waitForRequest\(([\s\S]{0,120})/g)]
  expect(requestObservers).toHaveLength(5)
  expect(requestObservers.every(match => match[1].includes('isPostChatStreamRequest'))).toBe(true)
  expect(spec).not.toMatch(/waitForRequest\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>[\s\S]{0,300}?\.request\(\)/)
  expect(cancellation).toContain('boundedCancellationResponseStatus')
  expect(cancellation).toContain('boundedCancellationSettlementReason')
  for (const reason of [
    'stop_button_not_ready', 'request_completed_before_cancel',
    'cancel_http_failed', 'terminal_audit_timeout',
    'cancellation_settlement_inconsistent',
  ]) expect(cancellation).toContain(reason)
})

test('production capability search distinguishes API, index, UI, and opening failures', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const search = spec.slice(
    spec.indexOf("if (bootstrap?.features.web_content_search)"),
    spec.indexOf("const archiveTarget"),
  )
  for (const reason of [
    'search_api_failed', 'search_index_timeout', 'frontend_search_stale',
    'search_result_not_openable',
  ]) expect(search).toContain(reason)
  expect(search).toContain('matchingThread.click()')
  expect(search).toContain('toHaveClass(/active/')
})

test('production capability safe summary includes content-free completion diagnostics', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  for (const field of [
    'cache_hit:item.cacheHit',
    'cache_hit_kind:item.cacheHitKind',
    'finish_reason:item.finishReason',
    'completion_status:item.completionStatus',
    'output_contract_check_status_counts:item.outputContractCheckStatusCounts',
    'repair_attempted:item.repairAttempted',
    'generation_stage_count:item.generationStageCount',
    'repair_stage_count:item.repairStageCount',
    'persisted_quality_status:item.persistedQualityStatus',
    'sse_quality_status:item.sseQualityStatus',
  ]) expect(spec).toContain(field)
})

test('production capability deployment parity gates authentication and questions', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const parity = spec.indexOf('await enforceProductionDeploymentParity({')
  const privateState = spec.indexOf('const privateRoot =')
  const authentication = spec.indexOf(
    'const authenticated = await loginProductionTriag<Bootstrap>',
  )
  const firstQuestion = spec.indexOf(
    "if (batchIncludes(gate.batch, 'core')) await runCore()",
  )
  expect(parity).toBeGreaterThan(0)
  expect(parity).toBeLessThan(privateState)
  expect(parity).toBeLessThan(authentication)
  expect(parity).toBeLessThan(firstQuestion)
  expect(spec).toContain('expectedCommitSha:process.env.GITHUB_SHA')
  expect(spec).toContain("page.request.get('/api/version'")
})

test('deployment mismatch GitHub summary is restricted to parity fields', () => {
  const workflow = readFileSync(
    resolve(process.cwd(), '../.github/workflows/deployed-smoke.yml'), 'utf8',
  )
  const start = workflow.indexOf(
    `if [[ "$MODE" == 'production-capability' && -f web/test-results/production-capability-summary.json ]]; then`,
  )
  const end = workflow.indexOf('hostname=$(node -e', start)
  const mismatchSummary = workflow.slice(start, end)
  expect(start).toBeGreaterThan(0)
  for (const field of [
    'expected_commit_sha', 'observed_backend_release',
    'deployment_parity_status', 'deployment_parity_checks',
    'deployment_parity_elapsed_wait_ms',
  ]) expect(mismatchSummary).toContain(field)
  for (const unsafeField of [
    'E2E_TEST_EMAIL', 'E2E_TEST_PASSWORD', 'bootstrap', 'BASE_URL',
  ]) expect(mismatchSummary).not.toContain(unsafeField)
  expect(mismatchSummary).toContain('exit 0')
})

test('mandatory exact-format failures cannot retain passed status', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const evaluation = spec.slice(
    spec.indexOf('function evaluation('), spec.indexOf('class PaceGate'),
  )
  expect(evaluation).toContain('mandatoryConstraintFailed = true')
  expect(evaluation).toMatch(/const passed = scored\.score >= 75\s*&& !mandatoryConstraintFailed/)
})

test('observed Playwright promises remain rejectable when consumed', async () => {
  const observed = observePlaywrightPromise(Promise.reject(new Error('observer_failed')))
  await expect(observed).rejects.toThrow('observer_failed')
})

test('tier cleanup failure preserves the primary failure and still writes the safe summary', async () => {
  const cleanupErrors: string[] = []
  let laterCleanupRan = false
  let writtenSummary: { primary_failure: string | null; cleanup: readonly string[] } | null = null
  await runCleanupActionSafely(cleanupErrors, 'tier_restore_failed', async () => {
    throw new Error('tier restoration transport failed')
  })
  await runCleanupActionSafely(cleanupErrors, 'profile_restore_failed', async () => {
    laterCleanupRan = true
  })
  const result = await writeFinalSafetyReports({
    primaryFailure:'chat_request_observer_failed',
    cleanupErrors,
    preliminaryReports:[],
    buildSafeSummary:errors => ({
      primary_failure:'chat_request_observer_failed',
      cleanup:[...errors],
    }),
    writeSafeSummary:async summary => { writtenSummary = summary },
  })
  expect(laterCleanupRan).toBe(true)
  expect(result.primaryFailure).toBe('chat_request_observer_failed')
  expect(result.safeSummaryWritten).toBe(true)
  expect(writtenSummary).toEqual({
    primary_failure:'chat_request_observer_failed',
    cleanup:['tier_restore_failed'],
  })
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

test('generated-thread deletion accepts 204 and deletes only that thread', async () => {
  const api = new FakeApi()
  await deleteGeneratedThread(
    api, 'generated-thread', new Set(['existing-thread']),
    new Set(['generated-thread']),
  )
  expect([...api.threads]).toEqual(['existing-thread'])
  await expect(deleteGeneratedThread(
    api, 'existing-thread', new Set(['existing-thread']),
    new Set(['generated-thread']),
  )).rejects.toBeInstanceOf(ThreadCleanupError)
})

test('application/json 204 with an empty body returns null without parsing', async () => {
  const response = {
    status:vi.fn(() => 204),
    headers:vi.fn(() => ({ 'content-type':'application/json' })),
    body:vi.fn(() => Promise.resolve(Buffer.alloc(0))),
    json:vi.fn(() => Promise.reject(new SyntaxError('empty JSON'))),
  }
  const requestContext = {
    fetch:vi.fn(() => Promise.resolve(response)),
  } as unknown as APIRequestContext
  const api = new AuthenticatedDeployedApi(
    requestContext, 'https://redacted.invalid', 'Bearer redacted',
  )
  await expect(api.request('DELETE', '/api/web/threads/generated'))
    .resolves.toEqual({ status:204, data:null })
  expect(response.json).not.toHaveBeenCalled()
  expect(response.body).not.toHaveBeenCalled()
})

test('malformed optional JSON preserves both successful and failure statuses', async () => {
  const statuses = [200, 503]
  const requestContext = {
    fetch:vi.fn(async () => ({
      status:() => statuses.shift()!,
      headers:() => ({ 'content-type':'application/json; charset=utf-8' }),
      body:() => Promise.resolve(Buffer.from('{malformed')),
    })),
  } as unknown as APIRequestContext
  const api = new AuthenticatedDeployedApi(
    requestContext, 'https://redacted.invalid', 'Bearer redacted',
  )
  await expect(api.request('GET', '/api/web/optional'))
    .resolves.toEqual({ status:200, data:null })
  await expect(api.request('GET', '/api/web/failure'))
    .resolves.toEqual({ status:503, data:null })
})

test('generated-thread deletion safely accepts a verified 404', async () => {
  const api: DeployedApi = {
    request:vi.fn(async method => ({
      status:method === 'DELETE' ? 404 : 404,
      data:null,
    })),
  }
  await expect(deleteGeneratedThread(
    api, 'generated-thread', new Set(['original-thread']),
    new Set(['generated-thread']),
  )).resolves.toBeUndefined()
  expect(api.request).toHaveBeenCalledTimes(2)
})

test('transient generated-thread cleanup failures retry within a hard bound', async () => {
  const statuses = [409, 429, 503, 204]
  let deleteCalls = 0
  const api: DeployedApi = {
    request:vi.fn(async method => {
      if (method === 'GET') return { status:404, data:null }
      const status = statuses[deleteCalls] ?? 500
      deleteCalls += 1
      return { status, data:null }
    }),
  }
  await deleteGeneratedThread(
    api, 'generated-thread', new Set(), new Set(['generated-thread']),
  )
  expect(deleteCalls).toBe(4)

  let boundedCalls = 0
  const failingApi: DeployedApi = {
    request:vi.fn(async () => {
      boundedCalls += 1
      return { status:503, data:null }
    }),
  }
  await expect(deleteGeneratedThread(
    failingApi, 'generated-thread', new Set(), new Set(['generated-thread']),
  )).rejects.toMatchObject({ reasonCode:'thread_delete_http_failure' })
  expect(boundedCalls).toBe(4)
})

test('exhausted thread deletion rate limits use the bounded rate code', async () => {
  let calls = 0
  const api: DeployedApi = {
    request:vi.fn(async () => {
      calls += 1
      return { status:429, data:null }
    }),
  }
  await expect(deleteGeneratedThread(
    api, 'generated-thread', new Set(), new Set(['generated-thread']),
  )).rejects.toMatchObject({ reasonCode:'thread_delete_rate_limited' })
  expect(calls).toBe(4)
})

test('original or untracked threads can never be deleted', async () => {
  const api: DeployedApi = { request:vi.fn() }
  await expect(deleteGeneratedThread(
    api, 'original-thread', new Set(['original-thread']),
    new Set(['original-thread']),
  )).rejects.toMatchObject({ reasonCode:'thread_delete_http_failure' })
  await expect(deleteGeneratedThread(
    api, 'unknown-thread', new Set(), new Set(['generated-thread']),
  )).rejects.toMatchObject({ reasonCode:'thread_delete_http_failure' })
  expect(api.request).not.toHaveBeenCalled()
})

test('thread deletion reports bounded parse and verification failures', async () => {
  const parseApi: DeployedApi = {
    request:vi.fn(async () => { throw new SyntaxError('empty JSON') }),
  }
  await expect(deleteGeneratedThread(
    parseApi, 'generated-thread', new Set(), new Set(['generated-thread']),
  )).rejects.toMatchObject({
    reasonCode:'thread_delete_response_parse_failure',
  })

  const verificationApi: DeployedApi = {
    request:vi.fn(async method => ({
      status:method === 'DELETE' ? 204 : 200,
      data:null,
    })),
  }
  await expect(deleteGeneratedThread(
    verificationApi, 'generated-thread', new Set(),
    new Set(['generated-thread']),
  )).rejects.toMatchObject({
    reasonCode:'thread_delete_verification_failure',
  })
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
