import {
  assertUsableTokenCredits, AuthenticatedDeployedApi,
  deleteGeneratedKnowledgeDocument,
  deleteGeneratedRepository, deleteGeneratedThread, deleteGeneratedUpload,
  isPostChatStreamRequest, isPostChatStreamResponse,
  observePlaywrightPromise, productionRequestViolation,
  resolveCapabilityAssistantRepresentation,
  restoreProfile, restoreUsagePreferences, runCleanupActionSafely,
  runWithBoundedConcurrency, withBoundedTimeout,
  ThreadCleanupError,
  waitForDeployedWorkspace, writeFinalSafetyReports,
  type ApiResult, type DeployedApi, type RestorableProfile, type RestorableUsagePreferences,
} from './deployedSafety'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { APIRequestContext, Page, Request, Response } from '@playwright/test'
import { evaluateWebhookArchitecture } from './productionCapabilitySafety'

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
    ['editRequestPromise', 'waitForRequest'],
    ['editResponsePromise', 'waitForResponse'],
    ['regenerateRequestPromise', 'waitForRequest'],
    ['regenerateResponsePromise', 'waitForResponse'],
    ['continuationRequestPromise', 'waitForRequest'],
    ['continuationResponsePromise', 'waitForResponse'],
  ]) {
    expect(spec).toMatch(new RegExp(
      `const ${observer} = observePlaywrightPromise\\(page\\.${matcher}\\(\\s*isPostChatStream${matcher === 'waitForRequest' ? 'Request' : 'Response'}`,
    ))
  }
  const cancellation = spec.slice(
    spec.indexOf('let cancellationRequestId'),
    spec.indexOf("workflowResults.push({ id:'J-DISCONNECT-RECOVERY'"),
  )
  expect(cancellation).toMatch(
    /requestPromise\s*=\s*observePlaywrightPromise\(page\.waitForRequest\(\s*isPostChatStreamRequest/,
  )
  expect(cancellation).toMatch(
    /cancellationResponseObserver\s*=\s*observePlaywrightPromise\(page\.waitForResponse\(\s*isPostChatStreamResponse/,
  )
  const requestObservers = [...spec.matchAll(/waitForRequest\(([\s\S]{0,120})/g)]
  expect(requestObservers).toHaveLength(7)
  expect(requestObservers.filter(
    match => match[1].includes('isPostChatStreamRequest'),
  )).toHaveLength(6)
  expect(spec).not.toMatch(/waitForRequest\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>[\s\S]{0,300}?\.request\(\)/)
  expect(cancellation).toContain('boundedCancellationResponseStatus')
  expect(cancellation).toContain('boundedCancellationSettlementReason')
  expect(cancellation).toContain('cancel_post_observed')
  expect(cancellation).toContain('cancel_http_status')
  expect(cancellation).toContain('cancel_attempt_1_http_status')
  expect(cancellation).toContain('cancel_attempt_2_http_status')
  expect(cancellation).toContain('shouldRetryCapabilityCancellation')
  expect(cancellation).toContain("await page.waitForTimeout(Math.min(1_000")
  expect(cancellation).toContain('request_already_completed')
  expect(cancellation).toContain('terminal_audit_state')
  for (const reason of [
    'stop_button_not_ready', 'request_completed_before_cancel',
    'cancel_http_failed', 'terminal_audit_timeout',
    'cancellation_settlement_inconsistent',
  ]) expect(cancellation).toContain(reason)
  expect(cancellation).not.toContain('.body()')
  expect(cancellation).toContain('discoverGeneratedThread')
  expect(cancellation).toContain('pollAudit(')
})

test('production capability browser waits and cleanup are independently bounded', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain("page.waitForEvent(\n            'download', { timeout:BROWSER_TOOL_TIMEOUT_MS }")
  expect(spec).toContain("'response_download_timeout'")
  expect(spec).toContain('const cleanupDeadline = Date.now() + capabilityCleanupDeadlineMs(')
  expect(spec).toContain('runWithBoundedConcurrency(ids, 2')
  expect(spec).toContain('const timeout = cleanupRemaining(150_000)')
  expect(spec).not.toContain('const timeout = cleanupRemaining(45_000)')
  expect(spec).toContain('await deleteThreadPass(firstThreadFailures)')
  expect(spec).toContain('const executionDeadline = testStartedAt')
  expect(spec).toContain("cleanupErrors.push('cleanup_global_timeout')")
  expect(spec).toContain('forceCancelActiveCapabilityRequests<Audit>({')
  expect(spec).toContain('const usageAudits = forcedTerminal?.audits ?? await pollCapabilityAudits<Audit>({')
  expect(spec).not.toMatch(/for \(const requestId of benchmarkRequestIds\)[\s\S]{0,300}pollAudit/)
  expect(spec).toContain('const heartbeat = setInterval(')
  expect(spec).toContain('completed_scenario_ids:')
  expect(spec).toContain('last_progress_timestamp:lastProgressTimestamp')
  expect(spec).toContain("progress('safe_summary_write_start'")
  expect(spec).toContain("progress('safe_summary_write_complete'")
})

test('production capability uses persisted Markdown for structural scoring and bounded reasons', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain(
    'question, redacted.text, rawRedacted.text, audit, sources, codeTest',
  )
  expect(spec).toContain('const structure = rawMarkdown.trim()')
  for (const reason of [
    'chat_request_not_observed', 'chat_response_not_observed',
    'assistant_ui_timeout', 'response_body_timeout',
    'assistant_persistence_missing', 'request_audit_timeout',
    'wallet_read_failed', 'tier_audit_unavailable',
    'copy_control_missing', 'clipboard_mismatch',
    'download_control_missing', 'response_download_timeout',
    'download_mismatch', 'editor_control_missing',
    'editor_apply_failed', 'raw_message_verification_failed',
  ]) expect(spec).toContain(reason)
  expect(spec).not.toContain('response_tools_harness_failure')
  expect(spec).toContain('contract_validation_disagreement')
  expect(spec).toContain('architecture_contract_disagreement')
  expect(spec).toContain('architecture_missing_area_identifiers')
  expect(spec).toContain('pre_repair_failed_check_identifiers')
  expect(spec).toContain('repair_trigger_area_identifiers')
  expect(spec).toContain('post_repair_failed_check_identifiers')
  expect(spec).toContain('architecture_repair_mode')
  expect(spec).toContain('const architecture = evaluateWebhookArchitecture(structure)')
  expect(spec.match(/evaluateWebhookArchitecture\(rawRedacted\.text\)/g))
    .toHaveLength(2)
  expect(spec).not.toContain('evaluateWebhookArchitecture(redacted.text)')
  expect(spec.match(/evaluateIdempotencySemantics\(structure\)/g))
    .toHaveLength(2)
  expect(spec.match(/evaluateIdempotencySemantics\(rawRedacted\.text\)/g))
    .toHaveLength(1)
  expect(spec).not.toContain('evaluateIdempotencySemantics(redacted.text)')
  expect(spec).toContain(
    'idempotencySemanticContractPassed(\n        rawRedacted.text',
  )
  expect(spec).toContain('representationCounts:capabilityAnswerRepresentationCounts(')
  expect(spec).toContain("const cancellationMarker = `CANCEL-${randomUUID()}`")
  expect(spec).not.toContain('For cancellation audit ${runId}')
  expect(spec).toContain("throw new Error('cancellation_precondition_not_met')")
  expect(spec).toContain("candidate.status !== 'passed'")
  expect(spec).toMatch(
    /case 'B03':[\s\S]{0,500}architecture_sections_missing[\s\S]{0,100}mandatoryConstraintFailed = true/,
  )
})

test('isolated assistant persistence races are bounded without aborting the batch', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain('async function pollRawMessage(')
  expect(spec).toContain('assistantPersistenceFailures += 1')
  expect(spec).toContain('assistantPersistenceFailures > 3')
  expect(spec).toContain("primaryFailure ??= 'assistant_persistence_systemic_outage'")
  expect(spec).toContain('assistant_persistence_failures:assistantPersistenceFailures')
  const isolatedFailure = spec.indexOf(
    "if (['assistant_persistence_missing', 'assistant_ui_timeout']",
  )
  expect(isolatedFailure).toBeGreaterThan(0)
  expect(spec.indexOf('return failedResult', isolatedFailure)).toBeGreaterThan(
    isolatedFailure,
  )
})

test('R08 routing variation reuses the B01 semantic and format contract', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const routing = spec.slice(
    spec.indexOf("if (question.id === 'R08' && ("),
    spec.indexOf("if (question.id === 'R09'", spec.indexOf("if (question.id === 'R08' && (")),
  )
  expect(routing).toContain(
    '!b01ContractPassed(result.rawMarkdown)',
  )
  expect(routing).not.toContain('result.score !== 100')
  expect(spec).toContain('function b01ContractPassed(')
})

test('edited continuity branch has a unique scenario id and summaries enforce it', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain("id:'D06-EDIT'")
  expect(spec).toContain('assertUniqueCapabilityScenarioIds(')
  expect(spec).toContain('results.map(item => item.scenarioId)')
})

test('targeted architecture fixtures use the shared coverage expectations', () => {
  const fixtures = JSON.parse(readFileSync(
    resolve(process.cwd(), '../shared-fixtures/capability-semantics.json'),
    'utf8',
  )) as { architecture_coverage: Array<{
    id: string
    text: string
    missing_areas: string[]
  }> }
  for (const id of [
    'subsections-numbered-lists', 'rendered-innertext-no-markers',
    'empty-headed-section-not-rescued', 'test-plan-scenario-phrasing',
    'security-verb-form-phrasing', 'out-of-order-natural-phrasing',
  ]) {
    const fixture = fixtures.architecture_coverage.find(item => item.id === id)
    expect(fixture, id).toBeDefined()
    const result = evaluateWebhookArchitecture(fixture?.text ?? '')
    expect(result.missingAreas, id).toEqual(fixture?.missing_areas)
    expect(result.validatorVersion, id).toBe('2026-08-03.6')
  }
})

test('hanging deployed API requests fail with a bounded transport reason', async () => {
  const requestContext = {
    fetch:vi.fn(() => new Promise(() => undefined)),
    post:vi.fn(() => new Promise(() => undefined)),
  } as unknown as APIRequestContext
  const api = new AuthenticatedDeployedApi(
    requestContext, 'https://redacted.invalid', 'Bearer redacted', 20,
  )
  await expect(api.request('GET', '/api/web/never'))
    .rejects.toMatchObject({ reasonCode:'deployed_api_timeout' })
  await expect(api.requestMultipart('/api/web/uploads', {
    file:{ name:'synthetic.txt', mimeType:'text/plain', buffer:Buffer.from('x') },
  })).rejects.toMatchObject({ reasonCode:'deployed_api_timeout' })
})

test('one timed-out cleanup action does not stop later cleanup work', async () => {
  const cleanupErrors: string[] = []
  const completed: string[] = []
  await runWithBoundedConcurrency(['hang', 'later'], 1, async item => {
    await runCleanupActionSafely(cleanupErrors, `${item}_timeout`, async () => {
      if (item === 'hang') await new Promise(() => undefined)
      completed.push(item)
    }, 20)
  })
  expect(cleanupErrors).toEqual(['hang_timeout'])
  expect(completed).toEqual(['later'])
})

test('bounded workflow timeout still permits safe-summary generation', async () => {
  let safeSummaryWritten = false
  let primaryFailure: string | null = 'website_audit_timeout'
  await expect(withBoundedTimeout(
    () => new Promise(() => undefined), 20, 'website_audit_timeout',
  )).rejects.toThrow('website_audit_timeout')
  const cleanupErrors = ['cleanup_global_timeout']
  const report = await writeFinalSafetyReports({
    primaryFailure,
    cleanupErrors,
    preliminaryReports:[],
    buildSafeSummary:errors => ({ primary_failure:primaryFailure, errors }),
    writeSafeSummary:async () => { safeSummaryWritten = true },
  })
  primaryFailure = report.primaryFailure
  expect(primaryFailure).toBe('website_audit_timeout')
  expect(report.cleanupErrors).toContain('cleanup_global_timeout')
  expect(safeSummaryWritten).toBe(true)
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
    'task_requirement_check_status_counts:item.taskRequirementCheckStatusCounts',
    'repair_attempted:item.repairAttempted',
    'generation_stage_count:item.generationStageCount',
    'repair_stage_count:item.repairStageCount',
    'reasoning_effort:item.reasoningEffort',
    'repair_reasoning_effort:item.repairReasoningEffort',
    'effective_max_output_tokens:item.effectiveMaxOutputTokens',
    'visible_output_reserve_tokens:item.visibleOutputReserveTokens',
    'reasoning_budget_cap_tokens:item.reasoningBudgetCapTokens',
    'reasoning_starved_retry:item.reasoningStarvedRetry',
    'turn_lifecycle_stage:item.turnLifecycleStage',
    'turn_lifecycle_events:item.turnLifecycleEvents',
    'turn_lifecycle_reason:item.turnLifecycleReason',
    'generation_output_tokens:item.generationOutputTokens',
    'generation_reasoning_tokens:item.generationReasoningTokens',
    'generation_visible_output_tokens:item.generationVisibleOutputTokens',
    'repair_reasoning_tokens:item.repairReasoningTokens',
    'persisted_quality_status:item.persistedQualityStatus',
    'sse_quality_status:item.sseQualityStatus',
    'definition_present:item.semanticEvaluation.definitionPresent',
    'concrete_retry_example_present:',
    'stable_outcome_present:item.semanticEvaluation.stableOutcomePresent',
    'postgres_authoritative:item.architectureEvaluation.postgresAuthoritative',
    'redis_valkey_forbidden_authority_passed:',
    'covered_area_count:item.architectureEvaluation.coveredAreaCount',
    'missing_area_identifiers:item.architectureEvaluation.missingAreas',
    'code_test_stderr:item.codeTestStderr',
    'code_test_command:item.codeTestCommand',
    'code_test_diff_first_20_lines:item.codeTestDiffFirst20Lines',
    'classification_notes:item.classificationNotes',
  ]) expect(spec).toContain(field)
  expect(spec).toContain('repair_turn_count:Math.min(')
  expect(spec).toContain('repair_reasoning_tokens_total:Math.min(')
})

test('long chat streams are observed through UI and audit before bounded body consumption', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const bodyObserver = spec.indexOf(
    'const sseBodyObserver = observePlaywrightPromise(response.body())',
  )
  const assistantObserver = spec.indexOf(
    'const assistantVisibleObserver = assistant.waitFor', bodyObserver,
  )
  const auditTerminal = spec.indexOf(
    'let audit = await auditObserver.catch', assistantObserver,
  )
  const bodyConsumption = spec.indexOf(
    '() => sseBodyObserver', auditTerminal,
  )
  expect(bodyObserver).toBeGreaterThan(0)
  expect(bodyObserver).toBeLessThan(assistantObserver)
  expect(assistantObserver).toBeLessThan(auditTerminal)
  expect(auditTerminal).toBeLessThan(bodyConsumption)
  expect(spec.slice(bodyObserver, bodyConsumption)).not.toContain(
    'remaining(RESPONSE_BODY_TIMEOUT_MS)',
  )
  expect(spec).toContain(
    'remainingCapabilitySseBodyTimeoutMs(questionDeadline, Date.now())',
  )
})

test('completed SSE streams reconcile the final stream lifecycle audit', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain('if (sendDiagnostics.doneSeen)')
  expect(spec).toContain('audit = await pollCapabilityStreamTerminal({')
  expect(spec).toContain('timeoutMilliseconds:Math.min(10_000, remaining(10_000))')
})

test('Tamil capability validation uses persisted Markdown for count and script', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain(
    "case 'C07': if (countSentences(structure) !== 5 || !/[\\u0B80-\\u0BFF]/u.test(structure))",
  )
  expect(spec).not.toContain(
    "case 'C07': if (countSentences(structure) !== 5 || !/[\\u0B80-\\u0BFF]/u.test(value))",
  )
  expect(spec).toContain(
    'observed_sentence_count:item.sentenceValidation.observedSentenceCount',
  )
  expect(spec).toContain(
    'contains_tamil_script:item.sentenceValidation.containsTamilScript',
  )
  expect(spec).toContain(
    'validator_version:item.sentenceValidation.validatorVersion',
  )
})

test('capability failures retain bounded pre-reservation send diagnostics', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain('send_http_status:item.sendHttpStatus')
  expect(spec).toContain('send_error_code:item.sendErrorCode')
  expect(spec).toContain('send_error_message:item.sendErrorMessage')
  expect(spec).toContain('send_sse_event_received:item.sendSseEventReceived')
  expect(spec).toContain('sse_event_order:item.sseEventOrder')
  expect(spec).toContain('sse_error_codes:item.sseErrorCodes')
  expect(spec).toContain('sse_error_messages:item.sseErrorMessages')
  expect(spec).toContain('sse_thread_seen:item.sseThreadSeen')
  expect(spec).toContain('sse_delta_seen:item.sseDeltaSeen')
  expect(spec).toContain('sse_done_seen:item.sseDoneSeen')
  expect(spec).toContain('repository_attached:item.repositoryAttached')
  expect(spec).toContain('assistant_lookup:item.assistantLookup')
  expect(spec).toContain(
    'assistant_request_id_matched:item.assistantRequestIdMatched',
  )
  expect(spec).toContain(
    'assistant_dom_request_ids:item.assistantDomRequestIds',
  )
  expect(spec).toContain('harness_thread_id:item.harnessThreadId')
  expect(spec).toContain('sse_thread_id:item.sseThreadId')
  expect(spec).toContain('sse_done_thread_id:item.sseDoneThreadId')
  expect(spec).toContain('sse_done_request_id:item.sseDoneRequestId')
  expect(spec).toContain('ui_active_thread_id:item.uiActiveThreadId')
  expect(spec).toContain("safeSendErrorDiagnostics(response.status(), errorBody)")
  expect(spec).toContain("'[REDACTED POTENTIAL SECRET]'")
  const parsed = spec.indexOf(
    'const sendDiagnostics: CapabilitySendDiagnostics',
  )
  const assistantFailure = spec.indexOf(
    'if (!assistantVisible || assistantTerminalTimedOut)', parsed,
  )
  expect(parsed).toBeGreaterThan(0)
  expect(assistantFailure).toBeGreaterThan(parsed)
})

test('repository question recovery preserves the active repository binding', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain("if (source.category === 'G')")
  expect(spec).toMatch(
    /if \(source\.category === 'G'\)[\s\S]{0,500}else \{[\s\S]{0,120}await freshChat\(page\)/,
  )
  expect(spec).toContain(
    "repositoryAttached:typeof payload.repository_id === 'string'",
  )
})

test('R09 reopens the authoritative persisted thread before reporting a UI timeout', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain(
    "const doneThreadId = String(doneEvent?.thread_id ?? '')",
  )
  expect(spec).toContain(
    'let threadId = doneThreadId || sseThreadId || String(payload.thread_id ?? \'\')',
  )
  expect(spec).toContain("question.id === 'R09'")
  expect(spec).toContain('reopenPersistedAssistantThread(')
  expect(spec).toContain('for (let index = 0; index < count')
  expect(spec).toContain('title_candidate_count:reopenResult.titleCandidateCount')
  expect(spec).toContain('selected_candidate_index:reopenResult.selectedCandidateIndex')
  expect(spec).toContain('audit_request_id:audit.request_id || null')
  expect(spec).toContain('audit_lookup_request_id:requestId')
  expect(spec).toContain('audit_lookup_thread_id:null')
  expect(spec).toContain('dom_selector_request_id:requestId')
  expect(spec).toContain('sse_thread_request_id:sseThreadRequestId || null')
  expect(spec).toContain('done_request_id:doneRequestId || null')
  expect(spec).toContain('done_message_id:doneMessageId || null')
  expect(spec).toContain('dom_assistant_request_ids_before_recovery:')
  expect(spec).toContain('dom_assistant_request_ids_at_timeout:')
  expect(spec).toContain('ui_thread_id_at_timeout:timeoutThreadId')
  expect(spec).toContain('ui_url_at_timeout:safeCurrentUrl')
  expect(spec).toContain('dom_selector_thread_id:timeoutThreadId')
  expect(spec).toContain('repair_attempted:audit.repair_attempted')
  expect(spec).toContain("assistantLookup = 'thread_reopen'")
  expect(spec).toContain("assistantLookup = 'api_fallback'")
  expect(spec).toContain(
    'const displayed = apiFallbackAnswer ?? await visibleAnswer(assistant)',
  )
  expect(spec).toContain(
    "nonBlockingReasonCodes.push(...representation.reasonCodes)",
  )
  expect(spec).toContain(
    'assistant_lookup_diagnostics:assistantLookupDiagnostics',
  )
  expect(spec).toContain(
    'dom_assistant_request_ids_at_timeout:timeoutRequestIds',
  )
})

test('all assistant lookup failures capture request, thread, DOM, and URL evidence', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain(
    "await recordAssistantLookupFailure('assistant_ui_timeout')",
  )
  expect(spec).toContain(
    "await recordAssistantLookupFailure('assistant_persistence_missing')",
  )
  expect(spec).toContain("'.message.assistant[data-request-id]'")
  expect(spec).toContain('sse_thread_request_id:sseThreadRequestId || null')
  expect(spec).toContain('done_request_id:doneRequestId || null')
  expect(spec).toContain('assistant_lookup_diagnostics:assistantLookupDiagnostics')
  expect(spec).toContain(
    'lookupDiagnostic?.dom_assistant_request_ids_at_timeout ?? []',
  )
  expect(spec).toContain(
    'availableDiagnosticId(\n          lookupDiagnostic?.authoritative_thread_id,',
  )
  expect(spec).toContain(
    'availableDiagnosticId(lookupDiagnostic?.sse_thread_id)',
  )
  expect(spec).toContain(
    'availableDiagnosticId(\n          lookupDiagnostic?.done_request_id,',
  )
  expect(spec).toContain(
    'availableDiagnosticId(\n          lookupDiagnostic?.ui_thread_id_at_timeout,',
  )
  expect(spec).toContain("assistantLookup = 'api_fallback'")
  expect(spec).toContain("nonBlockingReasonCodes.push(...representation.reasonCodes)")
})

test('assistant lookup falls back to the authoritative SSE message id', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain("const doneMessageId = String(doneEvent?.message_id ?? '')")
  expect(spec).toContain(
    '`.message.assistant[data-message-id="${doneMessageId}"]`',
  )
  expect(spec).toContain("assistantLookup = 'message_id'")
  expect(spec).toContain('requestIdMatched:assistantRequestIdMatched')
  expect(spec).toContain('onAudit:value => { capturedAudit = value }')
  expect(spec).toContain(
    'failedResult.turnLifecycleEvents = capturedAudit.turn_lifecycle_events',
  )
})

test('repository capability waits for a ready composer signal before G questions', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const wait = spec.indexOf('await waitForRepositoryReady(page)')
  const questions = spec.indexOf('for (const question of REPOSITORY_QUESTIONS)', wait)
  expect(wait).toBeGreaterThan(0)
  expect(questions).toBeGreaterThan(wait)
  expect(spec).toContain("'repository_readiness_timeout'")
})

test('cancellation waits for stream acceptance and stop readiness before audit polling', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const responseAccepted = spec.indexOf(
    '() => cancellationResponseObserver as Promise<Response>',
  )
  const responseStatus = spec.indexOf(
    'cancellationDiagnostics.stream_http_status', responseAccepted,
  )
  const stopReady = spec.indexOf(
    "'data-cancellation-ready', 'true'", responseStatus,
  )
  const auditPoll = spec.indexOf(
    'const readiness = await pollCancellationActive(', stopReady,
  )
  const stopClick = spec.indexOf('await stop.click()', auditPoll)
  expect(responseAccepted).toBeGreaterThan(0)
  expect(responseAccepted).toBeLessThan(responseStatus)
  expect(responseStatus).toBeLessThan(stopReady)
  expect(stopReady).toBeLessThan(auditPoll)
  expect(auditPoll).toBeLessThan(stopClick)
  expect(spec.slice(responseAccepted, auditPoll)).toContain(
    'Math.min(120_000, assertWithinDeadline())',
  )
  expect(spec.slice(stopReady, stopClick)).toContain(
    'Math.min(60_000, assertWithinDeadline())',
  )
  for (const field of [
    'stream_response_observed', 'stream_http_status', 'stop_button_ready',
    'readiness_poll_elapsed_ms', 'last_pre_cancel_state',
    'generation_stage_count', 'active_usage_stage_names',
    'cancel_post_observed', 'cancel_http_status', 'final_terminal_state',
  ]) expect(spec).toContain(field)
})

test('cleanup force-cancels benchmark-owned active requests before final usage audit', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const cleanup = spec.indexOf("progress('cleanup_start'")
  const forceCancel = spec.indexOf(
    'forceCancelActiveCapabilityRequests<Audit>', cleanup,
  )
  const usageEvaluation = spec.indexOf(
    'cleanupUsageDiagnostics.missing_request_ids', forceCancel,
  )
  expect(cleanup).toBeGreaterThan(0)
  expect(forceCancel).toBeGreaterThan(cleanup)
  expect(usageEvaluation).toBeGreaterThan(forceCancel)
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
  expect(spec).toContain(
    'page.request.get(deploymentVersionUrl(apiBaseUrl)',
  )
  expect(spec).not.toContain("page.request.get('/api/version'")
  expect(spec).toContain('page, gate.apiBaseUrl, timeoutMs')
})

test('production capability website audit discovers footer routes and stays bounded', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  expect(spec).toContain("workflowStart('J-PUBLIC-WEBSITE')")
  expect(spec).toContain("'footer a[href], .legal a[href]'")
  expect(spec).toContain("auditPage.locator('footer, .legal').first().waitFor")
  expect(spec).toContain('if (pageIndex >= 25) break')
  expect(spec).toContain('response.status() !== 200')
  expect(spec).toContain('await auditPage.title()')
  expect(spec).toContain("message.type() === 'error'")
  expect(spec).toContain('candidate.origin !== websiteOrigin')
  expect(spec).toContain('setViewportSize({ width:390, height:844 })')
  expect(spec).toContain("getByLabel('Message Swico').isVisible")
  expect(spec).toContain('missing_routes:[...missingWebsiteRoutes].join')
  expect(spec).toContain('tested_mobile_url:testedMobileUrl')
  for (const forbiddenPath of [
    '/legal/terms', '/legal/privacy', '/legal/refunds', '/legal/contact',
    '/legal/pricing', '/legal/delivery', '/legal/ai',
  ]) {
    const crawl = spec.slice(
      spec.indexOf("workflowStart('J-PUBLIC-WEBSITE')"),
      spec.indexOf('const privacyFailure =', spec.indexOf(
        "workflowStart('J-PUBLIC-WEBSITE')",
      )),
    )
    expect(crawl).not.toContain(forbiddenPath)
  }
})

test('routing scenarios assert content-free deterministic request-audit fields', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  for (const field of [
    'deterministic_intent', 'deterministic_route', 'scope_gate_reason',
    'provider_call_count', 'generation_stage_count',
  ]) expect(spec).toContain(field)
  expect(spec).toContain("result.deterministicRoute === 'backend_tool'")
  expect(spec).toContain("['R04', 'R10'].includes(question.id)")
  expect(spec).toContain("id:'R-ROUTING-AUDIT'")
  expect(spec).toContain("['all', 'full'].includes(gate.batch)")
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
    'backend_endpoint_hostname', 'last_http_status', 'safe_failure_reason',
  ]) expect(mismatchSummary).toContain(field)
  for (const unsafeField of [
    'E2E_TEST_EMAIL', 'E2E_TEST_PASSWORD', 'bootstrap', 'process.env.BASE_URL',
  ]) expect(mismatchSummary).not.toContain(unsafeField)
  expect(mismatchSummary).toContain("backend_release_unavailable")
  expect(mismatchSummary).toContain('exit 0')
})

test('production capability resolves the API base safely before Playwright', () => {
  const workflow = readFileSync(
    resolve(process.cwd(), '../.github/workflows/deployed-smoke.yml'), 'utf8',
  )
  const confirmationStart = workflow.indexOf(
    '- name: Confirm production capability benchmark',
  )
  const playwrightStart = workflow.indexOf(
    '- name: Run selected deployed Playwright suite',
  )
  const confirmation = workflow.slice(confirmationStart, playwrightStart)
  const resolution =
    'vars.PLAYWRIGHT_API_BASE_URL || secrets.PLAYWRIGHT_API_BASE_URL'
  expect(confirmationStart).toBeGreaterThan(0)
  expect(playwrightStart).toBeGreaterThan(confirmationStart)
  expect(confirmation).toContain(
    `PLAYWRIGHT_API_BASE_URL: \${{ ${resolution} }}`,
  )
  expect(resolution.indexOf('vars.')).toBeLessThan(
    resolution.indexOf('secrets.'),
  )
  expect(confirmation).toContain(
    "vars.PLAYWRIGHT_API_BASE_URL && 'environment_variable'",
  )
  expect(confirmation).toContain(
    "secrets.PLAYWRIGHT_API_BASE_URL && 'environment_secret_fallback'",
  )
  expect(confirmation).toContain(
    "|| 'missing'",
  )
  expect(confirmation).toContain(
    '::warning title=Production capability configuration::Move PLAYWRIGHT_API_BASE_URL',
  )
  expect(confirmation).toContain(
    "write_api_base_preflight_summary 'playwright_api_base_url_missing'",
  )
  expect(confirmation).toContain(
    "write_api_base_preflight_summary 'playwright_api_base_url_invalid'",
  )
  expect(confirmation).toContain("parsed.protocol === 'https:'")
  expect(confirmation).toContain('!parsed.username && !parsed.password')
  expect(confirmation).toContain('!parsed.search && !parsed.hash')
  expect(confirmation).toContain('exit 1')
  const outputLines = confirmation.split('\n').filter(line => (
    /echo|printf|stdout|stderr/u.test(line)
  )).join('\n')
  expect(outputLines).not.toMatch(
    /\$(?:\{PLAYWRIGHT_API_BASE_URL\}|PLAYWRIGHT_API_BASE_URL(?![A-Z0-9_]))/u,
  )
  expect(confirmation).toContain(
    "playwright_api_base_url_source:process.env.API_BASE_SOURCE",
  )
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
    .resolves.toEqual({ status:204, data:null, contentType:null })
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
    .resolves.toEqual({
      status:200, data:null, contentType:'application/json; charset=utf-8',
    })
  await expect(api.request('GET', '/api/web/failure'))
    .resolves.toEqual({
      status:503, data:null, contentType:'application/json; charset=utf-8',
    })
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
    { wait:async () => undefined },
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
    { wait:async () => undefined },
  )).rejects.toMatchObject({ reasonCode:'thread_delete_http_failure' })
  expect(boundedCalls).toBe(6)
})

test('thread deletion honors Retry-After without treating rate limiting as cleanup failure', async () => {
  const waits: number[] = []
  const statuses = [
    { status:429, data:null, retryAfterSeconds:60 },
    { status:204, data:null },
  ]
  const api: DeployedApi = {
    request:vi.fn(async method => (
      method === 'GET' ? { status:404, data:null } : statuses.shift()!
    )),
  }
  await expect(deleteGeneratedThread(
    api, 'generated-thread', new Set(), new Set(['generated-thread']),
    { wait:async milliseconds => { waits.push(milliseconds) } },
  )).resolves.toBeUndefined()
  expect(waits).toEqual([60_000])
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
    { wait:async () => undefined },
  )).rejects.toMatchObject({ reasonCode:'thread_delete_rate_limited' })
  expect(calls).toBe(6)
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

test('persisted assistant answer is an API fallback when the DOM times out', () => {
  expect(resolveCapabilityAssistantRepresentation({
    domObserved:false,
    domTerminal:false,
    persistedAnswer:'A complete persisted architecture answer.',
  })).toEqual({
    lookup:'api_fallback',
    answer:'A complete persisted architecture answer.',
    reasonCodes:['ui_render_not_observed'],
  })

  expect(resolveCapabilityAssistantRepresentation({
    domObserved:false,
    domTerminal:false,
    persistedAnswer:'',
  })).toEqual({ lookup:'unavailable', answer:null, reasonCodes:[] })
})

test('D03 reports provider truncation before content coverage', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
  )
  const d03 = spec.slice(
    spec.indexOf("case 'D03':"), spec.indexOf("case 'D04':"),
  )
  expect(d03).toContain("audit.finish_reason === 'length'")
  expect(d03).toContain("fail('generation_truncated')")
  expect(d03.indexOf("fail('generation_truncated')")).toBeLessThan(
    d03.indexOf("fail('transaction_boundary_missing')"),
  )
})
