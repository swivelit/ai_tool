import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import {
  adminAuditReasonCode,
  assertGreetingAudit,
  assertIsolatedGreetingPayload,
  authenticatedHeaderReasonCode,
  bootstrapReasonCode,
  boundedCombinedFailure,
  buildProductionTriagSummary,
  FreshChatHarnessError,
  freshChatStateReason,
  GreetingHarnessError,
  greetingAuditSubreason,
  loginObservationReasonCode,
  PRODUCTION_TRIAG_TEST_TIMEOUT_MS,
  productionCapabilityReasonCode,
  pollTerminalGreetingAudit,
  productionTriagPdfFixture,
  playwrightFreshChatProbe,
  resolveProductionCleanup,
  stabilizeFreshChat,
  supportedPdfUploadStatusSubreason,
  workspaceShellReasonCode,
  type ProductionBootstrap,
  type ProductionSafeScenarioResult,
  type GreetingSubreasonCode,
  type ProductionScenarioSubreasonCode,
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
  expect(workflow).toContain('fresh_chat_reason=${freshChatReason}')
  expect(workflow).toContain('fresh_chat_strategy=${freshChatStrategy}')
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

test('production TRIAG PDF fixture is structurally valid and backend-extractable', () => {
  const factualValue = 'TRIAG-FIXTURE-ACCEPTANCE'
  const fixture = productionTriagPdfFixture(factualValue)
  const source = fixture.toString('latin1')
  expect(source.startsWith('%PDF-1.4\n')).toBe(true)
  expect(source).toContain('\nxref\n0 6\n')
  expect(source).toMatch(/startxref\n\d+\n%%EOF\n$/)
  expect(source.match(/\/Type \/Page\b/g)).toHaveLength(1)
  expect(source).toContain('/Count 1')

  const backendPython = resolve(
    process.cwd(), '../backend/.venv/bin/python',
  )
  if (!existsSync(backendPython)) return
  const fixtureDirectory = mkdtempSync(
    resolve(tmpdir(), 'swico-triag-fixture-'),
  )
  const fixturePath = resolve(fixtureDirectory, 'fixture.pdf')
  try {
    writeFileSync(fixturePath, fixture)
    const extracted = spawnSync(backendPython, [
      '-c',
      [
        'import sys',
        'from app.web_api.document_extraction import extract_document',
        "result = extract_document(sys.argv[1], '.pdf')",
        "text = '\\n'.join(chunk.text for chunk in result.chunks)",
        'assert sys.argv[2] in text',
        'assert len(result.page_character_counts) == 1',
      ].join('; '),
      fixturePath,
      factualValue,
    ], { cwd:resolve(process.cwd(), '../backend') })
    expect(extracted.status).toBe(0)
  } finally {
    rmSync(fixtureDirectory, { recursive:true, force:true })
  }
})

test.each([
  [201, null],
  [400, 'supported_pdf_upload_http_4xx'],
  [422, 'supported_pdf_upload_http_4xx'],
  [500, 'supported_pdf_upload_http_5xx'],
  [503, 'supported_pdf_upload_http_5xx'],
  [200, 'supported_pdf_upload_response_invalid'],
] as const)('supported PDF upload status %s maps safely', (status, reasonCode) => {
  expect(supportedPdfUploadStatusSubreason(status)).toBe(reasonCode)
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
  states?: Array<FreshChatState | Error>
  direct?: 'clicked' | 'unavailable' | 'failed'
  sidebar?: 'clicked' | 'unavailable' | 'open_failed' | 'click_failed'
  shortcut?: 'pressed' | 'unavailable' | 'failed'
} = {}): FreshChatProbe & {
  directCalls: ReturnType<typeof vi.fn>
  sidebarCalls: ReturnType<typeof vi.fn>
  shortcutCalls: ReturnType<typeof vi.fn>
} {
  const states = options.states ?? [readyFreshChatState]
  let stateIndex = 0
  const directCalls = vi.fn(async () => options.direct ?? 'clicked' as const)
  const sidebarCalls = vi.fn(async () => (
    options.sidebar ?? 'unavailable' as const
  ))
  const shortcutCalls = vi.fn(async () => (
    options.shortcut ?? 'unavailable' as const
  ))
  return {
    directCalls,
    sidebarCalls,
    shortcutCalls,
    tryDirectButton:directCalls,
    trySidebarButton:sidebarCalls,
    tryKeyboardShortcut:shortcutCalls,
    readState:vi.fn(async () => {
      const state = states[Math.min(stateIndex, states.length - 1)]
      stateIndex += 1
      if (state instanceof Error) throw state
      return state
    }),
  }
}

test('already fresh workspace needs no New chat button or navigation', async () => {
  const probe = freshChatProbe({
    direct:'unavailable', sidebar:'unavailable', shortcut:'unavailable',
  })
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:20, pollMilliseconds:1,
  })).resolves.toBe('already_ready')
  expect(probe.directCalls).not.toHaveBeenCalled()
  expect(probe.sidebarCalls).not.toHaveBeenCalled()
  expect(probe.shortcutCalls).not.toHaveBeenCalled()
})

test('fresh chat resets a completed greeting conversation for the next scenario', async () => {
  const existingConversation = {
    ...readyFreshChatState,
    emptyStateHeadingVisible:false,
    textboxEmpty:false,
    messageCount:2,
    attachmentCount:1,
    repositoryCount:1,
  }
  const probe = freshChatProbe({
    states:[readyFreshChatState, existingConversation, readyFreshChatState],
    direct:'clicked', sidebar:'unavailable', shortcut:'unavailable',
  })
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:20, pollMilliseconds:1,
  })).resolves.toBe('already_ready')
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:20, pollMilliseconds:1,
  })).resolves.toBe('direct_button')
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:20, pollMilliseconds:1,
  })).resolves.toBe('already_ready')
  expect(probe.directCalls).toHaveBeenCalledTimes(1)
})

test('Playwright uses the unique New chat action and catches visibility errors', async () => {
  const button = {
    isVisible:vi.fn().mockRejectedValue(new Error('strict locator failure')),
    click:vi.fn(),
    waitFor:vi.fn(),
  }
  const composer = {
    locator:vi.fn(() => ({})),
    getByRole:vi.fn(() => ({})),
  }
  const page = {
    getByTestId:vi.fn((testId: string) => {
      if (testId === 'new-chat-button') return button
      if (testId === 'composer') return composer
      return {}
    }),
    getByRole:vi.fn(() => ({})),
    keyboard:{ press:vi.fn() },
    isClosed:vi.fn(() => false),
  } as unknown as Page

  const probe = playwrightFreshChatProbe(page)
  await expect(probe.tryDirectButton()).resolves.toBe('failed')
  expect(page.getByTestId).toHaveBeenCalledWith('new-chat-button')
  expect(button.isVisible).toHaveBeenCalledWith({ timeout:5_000 })
  expect(button.click).not.toHaveBeenCalled()
})

test('Playwright catches sidebar wait and click locator failures', async () => {
  const button = {
    isVisible:vi.fn().mockResolvedValue(false),
    click:vi.fn(),
    waitFor:vi.fn().mockRejectedValueOnce(new Error('wait failed')),
  }
  const trigger = {
    isVisible:vi.fn().mockResolvedValue(true),
    click:vi.fn().mockResolvedValue(undefined),
  }
  const composer = {
    locator:vi.fn(() => ({})),
    getByRole:vi.fn(() => ({})),
  }
  const page = {
    getByTestId:vi.fn((testId: string) => {
      if (testId === 'new-chat-button') return button
      if (testId === 'composer') return composer
      return {}
    }),
    getByRole:vi.fn(() => trigger),
    keyboard:{ press:vi.fn() },
    isClosed:vi.fn(() => false),
  } as unknown as Page

  const probe = playwrightFreshChatProbe(page)
  await expect(probe.trySidebarButton(1_000)).resolves.toBe('open_failed')
  button.waitFor.mockResolvedValueOnce(undefined)
  button.click.mockRejectedValueOnce(new Error('click failed'))
  await expect(probe.trySidebarButton(1_000)).resolves.toBe('click_failed')
})

test('temporarily stale old message is polled until cleared', async () => {
  const probe = freshChatProbe({ states:[
    { ...readyFreshChatState, messageCount:1 },
    { ...readyFreshChatState, messageCount:1 },
    readyFreshChatState,
  ] })
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:30, pollMilliseconds:1,
    retryClickAfterMilliseconds:20,
  })).resolves.toBe('direct_button')
  expect(probe.readState).toHaveBeenCalledTimes(3)
  expect(probe.directCalls).toHaveBeenCalledTimes(1)
})

test('visible direct New chat button succeeds with direct strategy', async () => {
  const probe = freshChatProbe({ states:[
    { ...readyFreshChatState, messageCount:1 }, readyFreshChatState,
  ] })
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:20, pollMilliseconds:1,
  })).resolves.toBe('direct_button')
  expect(probe.directCalls).toHaveBeenCalledTimes(1)
  expect(probe.sidebarCalls).not.toHaveBeenCalled()
  expect(probe.shortcutCalls).not.toHaveBeenCalled()
})

test('sidebar button and keyboard shortcut are layered fallbacks', async () => {
  const stale = { ...readyFreshChatState, messageCount:1 }
  const sidebarProbe = freshChatProbe({
    states:[stale, readyFreshChatState],
    direct:'unavailable', sidebar:'clicked', shortcut:'unavailable',
  })
  await expect(stabilizeFreshChat(sidebarProbe, {
    timeoutMilliseconds:20, pollMilliseconds:1,
  })).resolves.toBe('sidebar_button')
  expect(sidebarProbe.sidebarCalls).toHaveBeenCalledTimes(1)
  expect(sidebarProbe.shortcutCalls).not.toHaveBeenCalled()

  const shortcutProbe = freshChatProbe({
    states:[stale, readyFreshChatState],
    direct:'unavailable', sidebar:'unavailable', shortcut:'pressed',
  })
  await expect(stabilizeFreshChat(shortcutProbe, {
    timeoutMilliseconds:20, pollMilliseconds:1,
  })).resolves.toBe('keyboard_shortcut')
  expect(shortcutProbe.shortcutCalls).toHaveBeenCalledTimes(1)
})

test('fresh-chat stabilization retries navigation at most once', async () => {
  const probe = freshChatProbe({ states:[
    { ...readyFreshChatState, messageCount:1 },
    { ...readyFreshChatState, messageCount:1 },
  ] })
  await expect(stabilizeFreshChat(probe, {
    timeoutMilliseconds:8, pollMilliseconds:1,
    retryClickAfterMilliseconds:2,
  })).rejects.toMatchObject({
    reasonCode:'fresh_chat_messages_not_cleared',
  })
  expect(probe.directCalls).toHaveBeenCalledTimes(2)
})

test('keyboard and unavailable navigation failures map safely', async () => {
  const stale = { ...readyFreshChatState, messageCount:1 }
  await expect(stabilizeFreshChat(freshChatProbe({
    states:[stale], direct:'unavailable', sidebar:'unavailable',
    shortcut:'failed',
  }), { timeoutMilliseconds:5 })).rejects.toMatchObject({
    reasonCode:'fresh_chat_shortcut_failed',
    freshChatStrategy:'keyboard_shortcut',
  })
  await expect(stabilizeFreshChat(freshChatProbe({
    states:[stale], direct:'unavailable', sidebar:'unavailable',
    shortcut:'unavailable',
  }), { timeoutMilliseconds:5 })).rejects.toMatchObject({
    reasonCode:'fresh_chat_navigation_unavailable',
    freshChatStrategy:'keyboard_shortcut',
  })
})

test('fresh-chat failures are independent from greeting failures', async () => {
  const stale = { ...readyFreshChatState, messageCount:1 }
  let caught: unknown
  try {
    await stabilizeFreshChat(freshChatProbe({
      states:[stale], direct:'unavailable', sidebar:'unavailable',
      shortcut:'unavailable',
    }), { timeoutMilliseconds:5 })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(FreshChatHarnessError)
  expect(caught).not.toBeInstanceOf(GreetingHarnessError)
})

test('button and sidebar failures retain bounded navigation distinctions', async () => {
  const stale = { ...readyFreshChatState, messageCount:1 }
  await expect(stabilizeFreshChat(freshChatProbe({
    states:[stale], direct:'failed', sidebar:'unavailable',
    shortcut:'unavailable',
  }), { timeoutMilliseconds:5 })).rejects.toMatchObject({
    reasonCode:'fresh_chat_button_click_failed',
    freshChatStrategy:'direct_button',
  })
  await expect(stabilizeFreshChat(freshChatProbe({
    states:[stale], direct:'unavailable', sidebar:'open_failed',
    shortcut:'unavailable',
  }), { timeoutMilliseconds:5 })).rejects.toMatchObject({
    reasonCode:'fresh_chat_sidebar_open_failed',
    freshChatStrategy:'sidebar_button',
  })
})

test('final failure distinguishes navigation failure from state failure', async () => {
  const stale = { ...readyFreshChatState, attachmentCount:1 }
  await expect(stabilizeFreshChat(freshChatProbe({
    states:[stale], direct:'unavailable', sidebar:'unavailable',
    shortcut:'unavailable',
  }), { timeoutMilliseconds:5 })).rejects.toMatchObject({
    reasonCode:'fresh_chat_navigation_unavailable',
  })
  await expect(stabilizeFreshChat(freshChatProbe({
    states:[stale], direct:'clicked', sidebar:'unavailable',
    shortcut:'unavailable',
  }), {
    timeoutMilliseconds:5, pollMilliseconds:1,
    retryClickAfterMilliseconds:2,
  })).rejects.toMatchObject({
    reasonCode:'fresh_chat_attachments_not_cleared',
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

test.each([
  [{ textboxEmpty:false }, 'fresh_chat_textbox_not_empty'],
  [{ attachmentCount:1 }, 'fresh_chat_attachments_not_cleared'],
  [{ repositoryCount:1 }, 'fresh_chat_repository_not_cleared'],
] as const)(
  'verified navigation does not waive fresh workspace failure %s',
  async (change, reasonCode) => {
    const stale = { ...readyFreshChatState, ...change }
    await expect(stabilizeFreshChat(freshChatProbe({
      states:[stale], direct:'clicked', sidebar:'unavailable',
      shortcut:'unavailable',
    }), {
      timeoutMilliseconds:5, pollMilliseconds:1,
      retryClickAfterMilliseconds:2,
    })).rejects.toMatchObject({ reasonCode })
  },
)

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
  expect(safety).toContain("page.keyboard.press('Control+Shift+O')")
  expect(safety).not.toContain('fresh_chat_button_unavailable')
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
    'fresh_chat_button_click_failed', 'fresh_chat_sidebar_open_failed',
    'fresh_chat_shortcut_failed', 'fresh_chat_navigation_unavailable',
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

test('scenario-wide PDF, repository, and cancellation subreasons stay bounded', () => {
  const reasons: ProductionScenarioSubreasonCode[] = [
    'supported_pdf_fresh_chat_failed',
    'supported_pdf_tier_selection_failed',
    'supported_pdf_upload_input_missing',
    'supported_pdf_upload_request_not_observed',
    'supported_pdf_upload_http_4xx',
    'supported_pdf_upload_http_5xx',
    'supported_pdf_upload_response_invalid',
    'supported_pdf_upload_id_missing',
    'supported_pdf_attachment_not_ready',
    'supported_pdf_chat_request_not_observed',
    'supported_pdf_request_id_missing',
    'supported_pdf_assistant_not_visible',
    'supported_pdf_assistant_not_complete',
    'supported_pdf_sources_not_visible',
    'supported_pdf_audit_not_ready',
    'supported_pdf_document_source_missing',
    'supported_pdf_retrieval_not_sufficient',
    'supported_pdf_quality_not_grounded',
    'unsupported_pdf_tier_selection_failed',
    'knowledge_library_tier_selection_failed',
    'repository_fresh_chat_failed',
    'repository_tier_selection_failed',
    'repository_upload_input_missing',
    'repository_upload_request_not_observed',
    'repository_upload_http_failure',
    'repository_not_ready',
    'repository_chat_request_not_observed',
    'repository_quality_not_visible',
    'repository_static_only_label_missing',
    'repository_source_missing',
    'repository_quality_invalid',
    'cancellation_fresh_chat_failed',
    'cancellation_request_not_observed',
    'cancellation_request_id_missing',
    'cancellation_stop_button_unavailable',
    'cancellation_not_reached',
    'cancellation_audit_not_ready',
    'cancellation_duplicate_charge',
    'cancellation_orphaned_reservation',
    'cancellation_settlement_mismatch',
  ]
  const source = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  ) + readFileSync(
    resolve(process.cwd(), 'src/testing/productionTriagSafety.ts'), 'utf8',
  )
  for (const subreason_code of reasons) {
    const summary = buildProductionTriagSummary({
      preflight:{ status:'passed', reason_code:'preflight_passed' },
      scenarios:[{
        scenario:'supported_pdf', status:'failed', request_ids:[],
        reason_code:'supported_pdf_failed', subreason_code,
      }],
      cleanup:{ status:'complete', reason_codes:[] },
      primaryFailureReasonCode:'supported_pdf_failed',
    })
    expect(summary.scenarios[0].subreason_code).toBe(subreason_code)
    expect(source).toContain(subreason_code)
  }
})

test('supported PDF captures all upload statuses and UUID before later checks', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  const supported = spec.slice(
    spec.indexOf("await runScenario('supported_pdf'"),
    spec.indexOf("await runScenario('unsupported_pdf'"),
  )
  const listener = supported.slice(
    supported.indexOf('page.waitForResponse'),
    supported.indexOf('const uploaded ='),
  )
  expect(listener).toContain("response.request().method() === 'POST'")
  expect(listener).not.toContain('response.status() === 201')
  expect(supported.indexOf("recordRequest('supported_pdf', requestId)"))
    .toBeLessThan(supported.indexOf('supported_pdf_sources_not_visible'))
  expect(supported).toContain('supported_pdf_audit_not_ready')
})

test('PDF prerequisite skips only dependent scenarios while independent ones run', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  expect(spec).toContain('if (uploadReady && uploadId)')
  expect(spec).toContain(
    "prerequisite_reason_code:'supported_pdf_prerequisite_failed'",
  )
  expect(spec.indexOf("await runScenario('repository_pro'"))
    .toBeGreaterThan(spec.indexOf("supported_pdf_prerequisite_failed"))
  expect(spec.indexOf("await runScenario('cancellation_settlement'"))
    .toBeGreaterThan(spec.indexOf("supported_pdf_prerequisite_failed"))
})

test('content scenarios poll terminal audits instead of immediate audit reads', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  for (const reason of [
    'supported_pdf_audit_not_ready', 'unsupported_pdf_audit_not_ready',
    'knowledge_library_audit_not_ready', 'repository_audit_not_ready',
  ]) {
    expect(spec).toContain(`pollTerminalScenarioAudit(\n        api!, sent.requestId, '${reason}'`)
  }
})

test('production scenarios select and verify deterministic tiers and restore the original', () => {
  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  const segment = (start: string, end: string) => spec.slice(
    spec.indexOf(start), spec.indexOf(end),
  )
  for (const [start, end, tier, reason] of [
    ["await runScenario('supported_pdf'", "await runScenario('unsupported_pdf'", 'standard', 'supported_pdf_tier_selection_failed'],
    ["await runScenario('unsupported_pdf'", "await runScenario('knowledge_library'", 'standard', 'unsupported_pdf_tier_selection_failed'],
    ["await runScenario('knowledge_library'", "await runScenario('repository_pro'", 'standard', 'knowledge_library_tier_selection_failed'],
    ["await runScenario('repository_pro'", "await runScenario('cancellation_settlement'", 'pro', 'repository_tier_selection_failed'],
  ] as const) {
    const scenario = segment(start, end)
    expect(scenario).toContain(`api!, '${tier}', '${reason}'`)
  }
  expect(spec).toContain("'/api/web/settings/assistant'")
  expect(spec).toContain("verified.data?.tier !== originalTier")
  expect(spec).not.toContain('tierChanged')
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
    fresh_chat_strategy:'keyboard_shortcut',
    fresh_chat_reason_code:'fresh_chat_messages_not_cleared',
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
    fresh_chat_strategy:'keyboard_shortcut',
    fresh_chat_reason_code:'fresh_chat_messages_not_cleared',
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

test('safe summary retains only allowlisted content-free diagnostics', () => {
  const summary = buildProductionTriagSummary({
    preflight:{ status:'passed', reason_code:'preflight_passed' },
    scenarios:[{
      scenario:'repository_pro', status:'passed', request_ids:[requestId],
      selected_tier:'pro', retrieval_status:'sufficient',
      quality_status:'verified', source_kind_counts:{ repository:2, secret:9 },
      answer_check_status_counts:{ passed:3, unexpected:4 },
      repository_validation_mode:'static_only',
      phase2_fallback_reason_code:'dense_unavailable',
      cancellation_attempt_http_result:'http_200',
      cancellation_observed_audit_state:'cancelled',
    }],
    cleanup:{ status:'complete', reason_codes:[] },
    primaryFailureReasonCode:'none',
  })
  expect(summary.schema_version).toBe(3)
  expect(summary.scenarios[0]).toMatchObject({
    selected_tier:'pro', retrieval_status:'sufficient', quality_status:'verified',
    source_kind_counts:{ repository:2 },
    answer_check_status_counts:{ passed:3 },
    repository_validation_mode:'static_only',
    phase2_fallback_reason_code:'dense_unavailable',
    cancellation_attempt_http_result:'http_200',
    cancellation_observed_audit_state:'cancelled',
  })
  expect(JSON.stringify(summary)).not.toContain('secret')
  expect(JSON.stringify(summary)).not.toContain('unexpected')
})

test('safe summary preserves the pre-cleanup content-free rollout report', () => {
  const rolloutReport = {
    generated_at:'2026-08-01T00:00:00Z',
    window:{
      hours:24,
      started_at:'2026-07-31T00:00:00Z',
      ended_at:'2026-08-01T00:00:00Z',
    },
    groups:[{
      policy_version:'v1',
      feature_key:'web_triag_hybrid',
      rollout_cohort:'acceptance',
      metrics:{ total_eligible_requests:6, provider_call_count:4 },
    }],
  }
  const summary = buildProductionTriagSummary({
    preflight:{ status:'passed', reason_code:'preflight_passed' },
    scenarios:[],
    cleanup:{ status:'complete', reason_codes:[] },
    primaryFailureReasonCode:'none',
    rolloutReport,
  })
  expect(summary.rollout_report).toEqual(rolloutReport)

  const spec = readFileSync(
    resolve(process.cwd(), 'e2e/production-triag.spec.ts'), 'utf8',
  )
  expect(spec.indexOf("'GET', '/api/web/admin/triag-rollout-report'"))
    .toBeLessThan(spec.indexOf('deleteGeneratedThread('))
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
