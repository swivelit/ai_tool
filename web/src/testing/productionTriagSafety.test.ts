import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  adminAuditReasonCode,
  assertGreetingAudit,
  assertIsolatedGreetingPayload,
  authenticatedHeaderReasonCode,
  bootstrapReasonCode,
  boundedCombinedFailure,
  buildProductionTriagSummary,
  freshChatStateReason,
  greetingAuditSubreason,
  loginObservationReasonCode,
  PRODUCTION_TRIAG_TEST_TIMEOUT_MS,
  productionCapabilityReasonCode,
  pollTerminalGreetingAudit,
  resolveProductionCleanup,
  stabilizeFreshChat,
  workspaceShellReasonCode,
  type ProductionBootstrap,
  type ProductionSafeScenarioResult,
  type GreetingSubreasonCode,
  type FreshChatProbe,
  type FreshChatState,
} from './productionTriagSafety'
import type { DeployedApi } from './deployedSafety'

const requestId = '123e4567-e89b-42d3-a456-426614174000'

test('production test and GitHub command use matching 20-minute timeouts', () => {
  expect(PRODUCTION_TRIAG_TEST_TIMEOUT_MS).toBe(1_200_000)
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  const workflow = readFileSync(
    resolve(process.cwd(), '../.github/workflows/deployed-smoke.yml'), 'utf8',
  )
  expect(spec).toContain('test.setTimeout(PRODUCTION_TRIAG_TEST_TIMEOUT_MS)')
  expect(workflow).toContain(
    'npx playwright test "$test_file" --project=chromium --workers=1 --timeout=1200000',
  )
  expect(workflow).toContain('timeout-minutes: 30')
  expect(workflow).toContain('subreason=${subreason}')
  expect(workflow).toContain('prerequisite=${prerequisite}')
})

test('bootstrap status maps to bounded production preflight reasons', () => {
  expect(bootstrapReasonCode(200)).toBe('preflight_passed')
  expect(bootstrapReasonCode(401)).toBe('bootstrap_http_401')
  expect(bootstrapReasonCode(403)).toBe('bootstrap_http_403')
  expect(bootstrapReasonCode(500)).toBe('bootstrap_http_5xx')
  expect(bootstrapReasonCode(503)).toBe('bootstrap_http_5xx')
})

test('Firebase rejection, bearer absence, and workspace timeout map safely', () => {
  expect(loginObservationReasonCode('firebase_rejected'))
    .toBe('firebase_login_rejected')
  expect(loginObservationReasonCode('not_observed'))
    .toBe('bootstrap_not_observed')
  expect(authenticatedHeaderReasonCode(undefined))
    .toBe('authenticated_request_header_missing')
  expect(authenticatedHeaderReasonCode('Basic redacted'))
    .toBe('authenticated_request_header_missing')
  expect(authenticatedHeaderReasonCode('Bearer redacted'))
    .toBe('preflight_passed')
  expect(workspaceShellReasonCode(false)).toBe('workspace_shell_not_ready')
})

const completeBootstrap: ProductionBootstrap = {
  wallet:{ billing_exempt:true },
  features:{
    web_attachments:true,
    web_knowledge_library:true,
    web_repository_upload:true,
    web_repository_chat:true,
  },
  repositories:{ validation_capability:'static_only' },
  assistant:{ tier:'pro' },
}

test.each([
  [undefined, 'workspace_capability_missing'],
  [{ ...completeBootstrap, wallet:undefined }, 'workspace_capability_missing'],
  [{
    ...completeBootstrap,
    features:{ ...completeBootstrap.features, web_attachments:false },
  }, 'attachments_capability_missing'],
  [{
    ...completeBootstrap,
    features:{ ...completeBootstrap.features, web_knowledge_library:false },
  }, 'knowledge_library_capability_missing'],
  [{
    ...completeBootstrap,
    features:{ ...completeBootstrap.features, web_repository_upload:false },
  }, 'repository_upload_capability_missing'],
  [{
    ...completeBootstrap,
    features:{ ...completeBootstrap.features, web_repository_chat:false },
  }, 'repository_chat_capability_missing'],
  [{
    ...completeBootstrap,
    repositories:{ validation_capability:undefined },
  }, 'validator_capability_missing'],
  [{
    ...completeBootstrap,
    assistant:{ tier:undefined },
  }, 'assistant_tier_missing'],
] as const)(
  'missing production capability maps to %s safely',
  (bootstrap, reasonCode) => {
    expect(productionCapabilityReasonCode(
      bootstrap as unknown as ProductionBootstrap,
    )).toBe(reasonCode)
  },
)

test('complete production capabilities pass preflight classification', () => {
  expect(productionCapabilityReasonCode(completeBootstrap))
    .toBe('preflight_passed')
})

test('admin unknown-request 404 authorizes preflight while 401/403 fail', () => {
  expect(adminAuditReasonCode(404)).toBe('preflight_passed')
  expect(adminAuditReasonCode(401)).toBe('admin_audit_access_denied')
  expect(adminAuditReasonCode(403)).toBe('admin_audit_access_denied')
})

test('authentication failure before mutation needs no cleanup', () => {
  expect(resolveProductionCleanup(false, false, [])).toEqual({
    status:'not_required', reason_codes:[],
  })
  expect(resolveProductionCleanup(true, false, [])).toEqual({
    status:'not_required', reason_codes:[],
  })
})

test('combined failure preserves primary and real cleanup failures', () => {
  const noCleanup = resolveProductionCleanup(false, false, [])
  expect(boundedCombinedFailure('bootstrap_http_401', noCleanup))
    .toContain('primary=bootstrap_http_401')
  expect(boundedCombinedFailure('bootstrap_http_401', noCleanup))
    .toContain('cleanup_status=not_required')

  const failedCleanup = resolveProductionCleanup(true, true, [
    'thread_delete_verification_failure',
  ])
  const combined = boundedCombinedFailure(
    'supported_pdf_failed', failedCleanup,
  )
  expect(combined).toContain('primary=supported_pdf_failed')
  expect(combined).toContain('cleanup=thread_delete_verification_failure')

  const greetingCombined = boundedCombinedFailure(
    'deterministic_greeting_failed',
    resolveProductionCleanup(true, true, ['thread_delete_http_failure']),
  )
  expect(greetingCombined).toContain('primary=deterministic_greeting_failed')
  expect(greetingCombined).toContain('cleanup=thread_delete_http_failure')
})

test('isolated greeting payload has no previous thread, attachments, or repository', () => {
  expect(() => assertIsolatedGreetingPayload({
    request_id:requestId, message:'redacted', thread_id:null,
    repository_id:'', attachment_ids:[], input_mode:'text',
  })).not.toThrow()
  expect(() => assertIsolatedGreetingPayload({
    request_id:requestId, message:'redacted', input_mode:'text',
  })).not.toThrow()
  for (const payload of [
    { request_id:requestId, thread_id:'old-thread' },
    { request_id:requestId, attachment_ids:['old-upload'] },
    { request_id:requestId, attachment_ids:null },
    { request_id:requestId, repository_id:'old-repository' },
    { request_id:requestId, continue_message_id:'old-continuation' },
    { request_id:requestId, edit_message_id:'old-edit' },
    { request_id:requestId, regenerate_message_id:'old-regeneration' },
  ]) {
    expect(() => assertIsolatedGreetingPayload(payload)).toThrowError(
      expect.objectContaining({ reasonCode:'greeting_payload_not_isolated' }),
    )
  }
})

const readyFreshChatState: FreshChatState = {
  emptyStateHeadingVisible:true,
  conversationVisible:true,
  composerVisible:true,
  textboxVisible:true,
  textboxEnabled:true,
  textboxEmpty:true,
  messageCount:0,
  attachmentCount:0,
  repositoryCount:0,
}

function freshChatProbe(options: {
  buttonAvailable?: boolean
  clickError?: boolean
  states?: Array<FreshChatState | Error>
} = {}): FreshChatProbe & { clicks: ReturnType<typeof vi.fn> } {
  const states = options.states ?? [readyFreshChatState]
  let stateIndex = 0
  const clicks = vi.fn(async () => {
    if (options.clickError) throw new Error('private click error')
  })
  return {
    clicks,
    prepareNewChatButton:vi.fn(async () => options.buttonAvailable ?? true),
    clickNewChat:clicks,
    readState:vi.fn(async () => {
      const state = states[Math.min(stateIndex, states.length - 1)]
      stateIndex += 1
      if (state instanceof Error) throw state
      return state
    }),
  }
}

test('visible heading, empty textbox, and empty conversation pass fresh chat', async () => {
  const probe = freshChatProbe()
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:20, pollMilliseconds:1,
  })).resolves.toBeUndefined()
  expect(probe.clicks).toHaveBeenCalledTimes(1)
})

test('temporarily stale old message is polled until cleared', async () => {
  const probe = freshChatProbe({ states:[
    { ...readyFreshChatState, messageCount:1 },
    readyFreshChatState,
  ] })
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:30, pollMilliseconds:1,
    retryClickAfterMilliseconds:20,
  })).resolves.toBeUndefined()
  expect(probe.readState).toHaveBeenCalledTimes(2)
  expect(probe.clicks).toHaveBeenCalledTimes(1)
})

test('fresh-chat stabilization retries its click at most once', async () => {
  const probe = freshChatProbe({ states:[
    { ...readyFreshChatState, messageCount:1 },
  ] })
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:8, pollMilliseconds:1,
    retryClickAfterMilliseconds:2,
  })).rejects.toMatchObject({
    reasonCode:'fresh_chat_messages_not_cleared',
  })
  expect(probe.clicks).toHaveBeenCalledTimes(2)
})

test('missing New chat button and failed click map safely', async () => {
  await expect(stabilizeFreshChat(freshChatProbe({
    buttonAvailable:false,
  }), { timeoutMilliseconds:5 })).rejects.toMatchObject({
    reasonCode:'fresh_chat_button_unavailable',
  })
  await expect(stabilizeFreshChat(freshChatProbe({
    clickError:true,
  }), { timeoutMilliseconds:5 })).rejects.toMatchObject({
    reasonCode:'fresh_chat_click_failed',
  })
})

test.each([
  [{ textboxEmpty:false }, 'fresh_chat_textbox_not_empty'],
  [{ messageCount:1 }, 'fresh_chat_messages_not_cleared'],
  [{ attachmentCount:1 }, 'fresh_chat_attachments_not_cleared'],
  [{ repositoryCount:1 }, 'fresh_chat_repository_not_cleared'],
] as const)('fresh-chat state maps to %s safely', (change, reasonCode) => {
  const state = { ...readyFreshChatState, ...change }
  expect(freshChatStateReason(state)).toBe(reasonCode)
  expect(freshChatStateReason(state)).not.toBe('greeting_payload_not_isolated')
})

test('fresh-chat shell and composer failures remain distinct from payload isolation', () => {
  expect(freshChatStateReason({
    ...readyFreshChatState, emptyStateHeadingVisible:false,
  })).toBe('fresh_chat_shell_not_ready')
  expect(freshChatStateReason({
    ...readyFreshChatState, textboxEnabled:false,
  })).toBe('fresh_chat_composer_not_ready')
})

test('immediate audit 404 and active state are polled until terminal', async () => {
  const responses = [
    { status:404, data:null },
    { status:200, data:{ results:[{ cancellation_state:'active' }] } },
    { status:200, data:{ results:[{
      cancellation_state:'complete', provider_call_count:0,
      charged_micro_inr_total:0, settled_micro_inr_total:0,
      paid_usage_stage_count:0, duplicate_settlement_indicator:false,
      orphaned_active_reservation:false,
    }] } },
  ]
  let calls = 0
  const api: DeployedApi = {
    request:vi.fn(async () => responses[calls++] as never),
  }
  const result = await pollTerminalGreetingAudit(api, requestId, {
    timeoutMilliseconds:100, intervalMilliseconds:1,
  })
  expect(result.cancellation_state).toBe('complete')
  expect(calls).toBe(3)
})

const cleanGreetingAudit = {
  cancellation_state:'complete', provider_call_count:0,
  charged_micro_inr_total:0, settled_micro_inr_total:0,
  paid_usage_stage_count:0, duplicate_settlement_indicator:false,
  orphaned_active_reservation:false,
}

test.each([
  [{ ...cleanGreetingAudit, cancellation_state:'active' }, 'greeting_audit_not_ready'],
  [{ ...cleanGreetingAudit, orphaned_active_reservation:true }, 'greeting_audit_not_ready'],
  [{ ...cleanGreetingAudit, provider_call_count:1 }, 'greeting_provider_call_detected'],
  [{ ...cleanGreetingAudit, charged_micro_inr_total:1 }, 'greeting_nonzero_charge'],
  [{ ...cleanGreetingAudit, settled_micro_inr_total:1 }, 'greeting_nonzero_charge'],
  [{ ...cleanGreetingAudit, paid_usage_stage_count:1 }, 'greeting_paid_stage_detected'],
  [{ ...cleanGreetingAudit, duplicate_settlement_indicator:true }, 'greeting_duplicate_settlement'],
] as const)('greeting audit assertion maps safely to %s', (audit, reasonCode) => {
  expect(greetingAuditSubreason(audit)).toBe(reasonCode)
  expect(() => assertGreetingAudit(audit)).toThrowError(
    expect.objectContaining({ reasonCode }),
  )
})

test('clean terminal greeting audit passes every billing-exempt assertion', () => {
  expect(greetingAuditSubreason(cleanGreetingAudit)).toBeNull()
  expect(() => assertGreetingAudit(cleanGreetingAudit)).not.toThrow()
})

test('greeting starts fresh and captures its request before rendering waits', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  const greeting = spec.slice(
    spec.indexOf("await runScenario('deterministic_greeting'"),
    spec.indexOf("await runScenario('supported_pdf'"),
  )
  expect(greeting).toContain('await newChat(page)')
  expect(greeting).toContain('assertIsolatedGreetingPayload(payload)')
  expect(spec.indexOf('options.onRequestCaptured?.(requestId, payload)'))
    .toBeLessThan(spec.indexOf('await expect(assistant).toBeVisible'))
  expect(greeting).toContain("'fresh_chat_ready'")
  expect(greeting.slice(0, greeting.indexOf('let before'))).not.toContain(
    'greeting_payload_not_isolated',
  )
  const safety = readFileSync(
    resolve(process.cwd(), 'src/testing/productionTriagSafety.ts'), 'utf8',
  )
  expect(safety).toContain("page.getByTestId('conversation')")
  expect(safety).toContain("conversation.locator('article.message')")
  expect(safety).toContain("const composerContainer = composer.locator('..')")
})

test('request ID survives assistant rendering failure in the safe summary', () => {
  const summary = buildProductionTriagSummary({
    preflight:{ status:'passed', reason_code:'preflight_passed' },
    scenarios:[{
      scenario:'deterministic_greeting', status:'failed',
      request_ids:[requestId], reason_code:'deterministic_greeting_failed',
      subreason_code:'greeting_assistant_not_visible',
    }],
    cleanup:{ status:'complete', reason_codes:[] },
    primaryFailureReasonCode:'deterministic_greeting_failed',
  })
  expect(summary.scenarios[0]).toMatchObject({
    request_ids:[requestId],
    subreason_code:'greeting_assistant_not_visible',
  })
})

test('request UUID is retained before captured payload isolation fails', () => {
  const summary = buildProductionTriagSummary({
    preflight:{ status:'passed', reason_code:'preflight_passed' },
    scenarios:[{
      scenario:'deterministic_greeting', status:'failed',
      request_ids:[requestId], reason_code:'deterministic_greeting_failed',
      subreason_code:'greeting_payload_not_isolated',
    }],
    cleanup:{ status:'complete', reason_codes:[] },
    primaryFailureReasonCode:'deterministic_greeting_failed',
  })
  expect(summary.scenarios[0].request_ids).toEqual([requestId])
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  expect(spec.indexOf("recordRequest('deterministic_greeting', requestId)"))
    .toBeLessThan(spec.indexOf('assertIsolatedGreetingPayload(payload)'))
})

test('all bounded greeting subreasons are retained without private detail', () => {
  const reasons: GreetingSubreasonCode[] = [
    'fresh_chat_button_unavailable', 'fresh_chat_click_failed',
    'fresh_chat_shell_not_ready', 'fresh_chat_composer_not_ready',
    'fresh_chat_textbox_not_empty', 'fresh_chat_messages_not_cleared',
    'fresh_chat_attachments_not_cleared',
    'fresh_chat_repository_not_cleared', 'fresh_chat_state_timeout',
    'greeting_request_not_observed', 'greeting_request_id_missing',
    'greeting_payload_not_isolated', 'greeting_assistant_not_visible',
    'greeting_assistant_not_complete', 'greeting_response_empty',
    'greeting_wallet_read_failed', 'greeting_wallet_changed',
    'greeting_audit_not_ready', 'greeting_provider_call_detected',
    'greeting_nonzero_charge', 'greeting_paid_stage_detected',
    'greeting_duplicate_settlement',
  ]
  for (const subreason_code of reasons) {
    const summary = buildProductionTriagSummary({
      preflight:{ status:'passed', reason_code:'preflight_passed' },
      scenarios:[{
        scenario:'deterministic_greeting', status:'failed', request_ids:[],
        reason_code:'deterministic_greeting_failed', subreason_code,
      }],
      cleanup:{ status:'not_required', reason_codes:[] },
      primaryFailureReasonCode:'deterministic_greeting_failed',
    })
    expect(summary.scenarios[0].subreason_code).toBe(subreason_code)
  }
  const source = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  ) + readFileSync(
    resolve(process.cwd(), 'src/testing/productionTriagSafety.ts'), 'utf8',
  )
  for (const reason of reasons) expect(source).toContain(reason)
})

test('baseline failure prevents dependent production mutation scenarios', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  expect(spec).toContain(
    "if (safeResults.get('deterministic_greeting')?.status === 'passed')",
  )
  expect(spec).toContain(
    "prerequisite_reason_code:'deterministic_greeting_prerequisite_failed'",
  )
})

test('safe summary strips non-schema content and retains request UUIDs', () => {
  const scenario = {
    scenario:'supported_pdf',
    status:'failed',
    request_ids:[requestId, 'not-a-request-id'],
    reason_code:'supported_pdf_failed',
    email:'person@example.test',
    password:'secret-password',
    authorization:'Bearer secret-token',
    message:'raw message',
    answer:'raw answer',
    filename:'private.pdf',
    wallet_id:'wallet-private-id',
    url:'https://private.example.test/path',
    headers:{ 'x-private-header':'private-header-value' },
    source_locator:'page 1',
    provider:'private-provider',
    model:'private-model',
  } as ProductionSafeScenarioResult
  const freshScenario = {
    scenario:'deterministic_greeting',
    status:'failed',
    request_ids:[],
    reason_code:'deterministic_greeting_failed',
    subreason_code:'fresh_chat_messages_not_cleared',
    selector_error:'private DOM text',
    message:'private greeting',
    token:'private-token',
  } as ProductionSafeScenarioResult
  const summary = buildProductionTriagSummary({
    preflight:{ status:'passed', reason_code:'preflight_passed' },
    scenarios:[scenario, freshScenario],
    cleanup:{ status:'incomplete', reason_codes:['upload_delete_failed'] },
    primaryFailureReasonCode:'supported_pdf_failed',
  })
  const serialized = JSON.stringify(summary)
  expect(summary.scenarios[0].request_ids).toEqual([requestId])
  expect(summary.scenarios[1]).toMatchObject({
    request_ids:[], subreason_code:'fresh_chat_messages_not_cleared',
  })
  for (const forbidden of [
    'person@example.test', 'secret-password', 'secret-token', 'raw message',
    'raw answer', 'private.pdf', 'page 1', 'private-provider', 'private-model',
    'wallet-private-id', 'private.example.test', 'private-header-value',
    'private DOM text', 'private greeting', 'private-token',
  ]) {
    expect(serialized).not.toContain(forbidden)
  }
})

test('staging and production-readonly commands retain their existing timeout behavior', () => {
  const workflow = readFileSync(
    resolve(process.cwd(), '../.github/workflows/deployed-smoke.yml'), 'utf8',
  )
  expect(workflow).toContain(
    'npx playwright test "$test_file" --project=chromium --project=mobile-chromium',
  )
  const sharedSafety = readFileSync(
    resolve(process.cwd(), 'src/testing/deployedSafety.ts'), 'utf8',
  )
  expect(sharedSafety).toContain('export async function loginDeployed')
  expect(sharedSafety).toContain('await waitForDeployedWorkspace(page)')
  const loginHelper = sharedSafety.slice(
    sharedSafety.indexOf('export async function loginDeployed'),
    sharedSafety.indexOf('export async function logoutDeployed'),
  )
  expect(loginHelper).not.toContain("name:'Send message'")
})
