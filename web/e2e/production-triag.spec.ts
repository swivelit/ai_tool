import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  deleteGeneratedKnowledgeDocument,
  deleteGeneratedRepository,
  deleteGeneratedThread,
  deleteGeneratedUpload,
  logoutDeployed,
  ThreadCleanupError,
  type DeployedApi,
} from '../src/testing/deployedSafety'
import {
  assertGreetingAudit,
  assertIsolatedGreetingPayload,
  boundedCombinedFailure,
  buildProductionTriagSummary,
  GreetingHarnessError,
  FreshChatHarnessError,
  isProductionRequestId,
  loginProductionTriag,
  playwrightFreshChatProbe,
  pollTerminalGreetingAudit,
  productionTriagPdfFixture,
  PRODUCTION_TRIAG_TEST_TIMEOUT_MS,
  ProductionPreflightError,
  ProductionScenarioHarnessError,
  resolveProductionCleanup,
  stabilizeFreshChat,
  supportedPdfUploadStatusSubreason,
  type ProductionCleanup,
  type ProductionCleanupReasonCode,
  type ProductionPreflightReasonCode,
  type ProductionPrimaryFailureReasonCode,
  type ProductionSafeScenarioResult,
  type ProductionSafeSummary,
  type ProductionScenarioName,
  type ProductionScenarioReasonCode,
  type ProductionScenarioSubreasonCode,
  type FreshChatStrategy,
} from '../src/testing/productionTriagSafety'

test.skip(
  process.env.PLAYWRIGHT_MODE !== 'production-triag',
  'Production TRIAG acceptance only',
)

test.describe.configure({ mode:'serial' })

const WRITE_CONFIRMATION = 'I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION'
const email = process.env.E2E_TEST_EMAIL ?? ''
const password = process.env.E2E_TEST_PASSWORD ?? ''

type Bootstrap = {
  wallet: { available_micros: number; billing_exempt?: boolean }
  features: {
    web_attachments: boolean
    web_knowledge_library: boolean
    web_repository_upload: boolean
    web_repository_chat: boolean
  }
  repositories: {
    validation_capability: 'static_only' | 'executable'
  }
  assistant: { tier: 'lite' | 'standard' | 'pro' }
}
type ThreadList = { items: Array<{ id: string }>; has_more: boolean }
type KnowledgeDocument = {
  id: string
  status: 'pending' | 'indexing' | 'ready' | 'failed' | 'invalidated'
}
type KnowledgeResult = {
  document: KnowledgeDocument
  job: { status: string }
}
type AuditResult = {
  request_id: string
  usage_charge_row_count: number
  usage_stage_row_count: number
  provider_call_count: number
  reserved_micro_inr_total: number
  charged_micro_inr_total: number
  settled_micro_inr_total: number
  charge_status_counts: Record<string, number>
  usage_stage_status_counts: Record<string, number>
  active_usage_stage_names: string[]
  last_terminal_charge_status: 'settled' | 'billing_exempt' | 'released' | 'failed' | null
  paid_usage_stage_count: number
  duplicate_settlement_indicator: boolean
  source_count: number
  source_kind_counts: Record<string, number>
  retrieval_status: string
  quality_status: string
  answer_check_status_counts: Record<string, number>
  selected_tier: 'lite' | 'standard' | 'pro' | 'not_run'
  repository_validation_mode: 'static_only' | 'executable' | 'unavailable' | null
  phase2_fallback_reason_code: string | null
  cancellation_state: string
  cancellation_failure_count: number
  orphaned_active_reservation: boolean
}
type ScenarioDiagnostics = Pick<ProductionSafeScenarioResult,
  | 'selected_tier'
  | 'retrieval_status'
  | 'quality_status'
  | 'source_kind_counts'
  | 'answer_check_status_counts'
  | 'usage_stage_status_counts'
  | 'active_usage_stage_names'
  | 'last_terminal_charge_status'
  | 'repository_validation_mode'
  | 'phase2_fallback_reason_code'
  | 'cancellation_attempt_http_result'
  | 'cancellation_observed_audit_state'
>
type SetupReasonCode =
  | Exclude<ProductionPreflightReasonCode, 'preflight_passed'>
  | 'production_write_confirmation_missing'
  | 'thread_snapshot_failed'
  | 'knowledge_snapshot_failed'
  | 'unexpected_harness_failure'

class SafeHarnessError extends Error {
  constructor(readonly reasonCode: SetupReasonCode) {
    super(`Production TRIAG harness failed: ${reasonCode}`)
    this.name = 'SafeHarnessError'
  }
}

const scenarioNames: ProductionScenarioName[] = [
  'deterministic_greeting',
  'supported_pdf',
  'unsupported_pdf',
  'knowledge_library',
  'repository_pro',
  'cancellation_settlement',
]

const scenarioFailureReason: Record<
  ProductionScenarioName, ProductionScenarioReasonCode
> = {
  deterministic_greeting:'deterministic_greeting_failed',
  supported_pdf:'supported_pdf_failed',
  unsupported_pdf:'unsupported_pdf_failed',
  knowledge_library:'knowledge_library_failed',
  repository_pro:'repository_pro_failed',
  cancellation_settlement:'cancellation_settlement_failed',
}

const scenarioDefaultSubreason: Record<
  ProductionScenarioName, ProductionScenarioSubreasonCode
> = {
  deterministic_greeting:'greeting_harness_failure',
  supported_pdf:'supported_pdf_harness_failure',
  unsupported_pdf:'unsupported_pdf_harness_failure',
  knowledge_library:'knowledge_library_setup_failed',
  repository_pro:'repository_harness_failure',
  cancellation_settlement:'cancellation_harness_failure',
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff
  for (const byte of input) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function repositoryZip(): Buffer {
  const files = [
    {
      name:'calculator.js',
      data:Buffer.from('export function add(a, b) { return a - b }\n'),
    },
    {
      name:'calculator.test.js',
      data:Buffer.from("import { add } from './calculator.js'\nif (add(2, 3) !== 5) throw new Error('addition failed')\n"),
    },
    {
      name:'package.json',
      data:Buffer.from('{"type":"module","scripts":{"test":"node calculator.test.js"}}\n'),
    },
  ]
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const checksum = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, file.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(file.data.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + file.data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

async function openSidebar(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name:'Open sidebar' })
  if (await trigger.isVisible()) await trigger.click()
}

async function newChat(page: Page): Promise<FreshChatStrategy> {
  try {
    return await stabilizeFreshChat(playwrightFreshChatProbe(page))
  } catch (error) {
    if (error instanceof FreshChatHarnessError) throw error
    throw new FreshChatHarnessError(
      'fresh_chat_navigation_unavailable', 'direct_button',
    )
  }
}

async function scenarioFreshChat(
  page: Page,
  failureCode: ProductionScenarioSubreasonCode,
): Promise<FreshChatStrategy> {
  try {
    return await newChat(page)
  } catch (error) {
    if (error instanceof FreshChatHarnessError) {
      throw new ProductionScenarioHarnessError(
        failureCode, error.reasonCode, error.freshChatStrategy,
      )
    }
    throw new ProductionScenarioHarnessError(failureCode)
  }
}

function scenarioFailure(
  reasonCode: ProductionScenarioSubreasonCode,
): never {
  throw new ProductionScenarioHarnessError(reasonCode)
}

async function selectProductionTier(
  page: Page,
  api: DeployedApi,
  target: 'standard' | 'pro',
  failureCode: ProductionScenarioSubreasonCode,
): Promise<void> {
  const selector = page.locator('.tier-selector-composer')
  try {
    const current = await selector.getAttribute('data-selected-tier', {
      timeout:5_000,
    })
    let responseStatus: number
    if (current === target) {
      responseStatus = (await api.request(
        'PATCH', '/api/web/settings/assistant', { tier:target },
      )).status
    } else {
      const responsePromise = page.waitForResponse(response => (
        new URL(response.url()).pathname === '/api/web/settings/assistant'
        && response.request().method() === 'PATCH'
      ), { timeout:30_000 })
      await selector.getByRole('button').click({ timeout:5_000 })
      await selector.locator(`[data-tier-id="${target}"]`).click({
        timeout:5_000,
      })
      responseStatus = (await responsePromise).status()
    }
    if (responseStatus !== 200) scenarioFailure(failureCode)
    await expect(selector).toHaveAttribute('data-selected-tier', target, {
      timeout:30_000,
    })
    await expect(selector.getByRole('button')).toBeVisible({ timeout:5_000 })
  } catch (error) {
    if (error instanceof ProductionScenarioHarnessError) throw error
    scenarioFailure(failureCode)
  }
}

async function sendMessage(
  page: Page,
  message: string,
  options: {
    waitForCompletion?: boolean
    failureCodes?: {
      requestNotObserved: ProductionScenarioSubreasonCode
      requestIdMissing: ProductionScenarioSubreasonCode
      assistantNotVisible: ProductionScenarioSubreasonCode
      assistantNotComplete: ProductionScenarioSubreasonCode
    }
    onRequestCaptured?: (
      requestId: string,
      payload: Record<string, unknown>,
    ) => void
  } = {},
): Promise<{ requestId: string; assistant: Locator }> {
  const observed = page.waitForRequest(request => (
    new URL(request.url()).pathname === '/api/web/chat/stream'
    && request.method() === 'POST'
  ), { timeout:30_000 })
  let request: Awaited<typeof observed>
  try {
    await page.getByLabel('Message Swico').fill(message)
    await page.getByRole('button', { name:'Send message' }).click()
    request = await observed
  } catch {
    if (options.failureCodes) {
      throw new ProductionScenarioHarnessError(
        options.failureCodes.requestNotObserved,
      )
    }
    throw new Error('Production chat request was not observed')
  }
  let payload: Record<string, unknown>
  try {
    payload = request.postDataJSON() as Record<string, unknown>
  } catch {
    payload = {}
  }
  const requestId = payload.request_id
  if (!isProductionRequestId(requestId)) {
    if (options.failureCodes) {
      throw new ProductionScenarioHarnessError(
        options.failureCodes.requestIdMissing,
      )
    }
    throw new Error('Production request identifier was not captured')
  }
  // This callback runs before any DOM wait so the safe summary retains the
  // request ID even when rendering or stream completion subsequently fails.
  options.onRequestCaptured?.(requestId, payload)
  const assistant = page.locator(
    `.message.assistant[data-request-id="${requestId}"]`,
  )
  try {
    await expect(assistant).toBeVisible({ timeout:90_000 })
  } catch {
    if (options.failureCodes) {
      throw new ProductionScenarioHarnessError(
        options.failureCodes.assistantNotVisible,
      )
    }
    throw new Error('Production assistant response was not visible')
  }
  if (options.waitForCompletion !== false) {
    try {
      await expect(assistant).not.toHaveClass(/streaming/, { timeout:180_000 })
    } catch {
      if (options.failureCodes) {
        throw new ProductionScenarioHarnessError(
          options.failureCodes.assistantNotComplete,
        )
      }
      throw new Error('Production assistant response did not complete')
    }
  }
  return { requestId, assistant }
}

async function pollAudit(
  api: DeployedApi,
  requestId: string,
  predicate: (value: AuditResult) => boolean,
  timeoutMilliseconds = 30_000,
): Promise<AuditResult> {
  const deadline = Date.now() + timeoutMilliseconds
  let lastObserved: AuditResult | null = null
  while (Date.now() < deadline) {
    try {
      const response = await api.request<{ results: AuditResult[] }>(
        'POST', '/api/web/admin/triag-request-audit',
        { request_ids:[requestId] },
      )
      const current = response.status === 200
        ? response.data?.results[0] : undefined
      if (current) lastObserved = current
      if (current && predicate(current)) return current
    } catch {
      // Audit creation and terminal persistence are eventually consistent.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new AuditPollingError(lastObserved)
}

class AuditPollingError extends Error {
  constructor(readonly lastObserved: AuditResult | null) {
    super('TRIAG request audit did not reach the expected state')
    this.name = 'AuditPollingError'
  }
}

async function pollTerminalScenarioAudit(
  api: DeployedApi,
  requestId: string,
  failureCode: ProductionScenarioSubreasonCode,
  timeoutMilliseconds = 45_000,
  onTimeoutObserved?: (value: AuditResult) => void,
): Promise<AuditResult> {
  try {
    return await pollAudit(
      api, requestId,
      value => value.cancellation_state === 'complete',
      timeoutMilliseconds,
    )
  } catch (error) {
    if (error instanceof AuditPollingError && error.lastObserved) {
      onTimeoutObserved?.(error.lastObserved)
    }
    throw new ProductionScenarioHarnessError(failureCode)
  }
}

async function safeScreenshot(
  page: Page,
  directory: string,
  scenario: ProductionScenarioName | 'fresh_chat_ready',
): Promise<void> {
  await mkdir(directory, { recursive:true })
  await page.screenshot({
    path:resolve(directory, `${scenario}.png`),
    fullPage:true,
    mask:[
      page.locator('.message'),
      page.locator('.attachment-tray'),
      page.locator('.message-attachment-card'),
      page.locator('.threads'),
      page.locator('.account-button'),
      page.locator('.knowledge-library'),
      page.locator('.knowledge-list'),
      page.locator('textarea'),
    ],
  })
}

test('safe automated production TRIAG acceptance', async ({ page }) => {
  test.setTimeout(PRODUCTION_TRIAG_TEST_TIMEOUT_MS)
  const artifactRoot = resolve(process.cwd(), 'test-results')
  const screenshotDirectory = resolve(
    artifactRoot, 'production-triag-screenshots',
  )
  const summaryPath = resolve(
    artifactRoot, 'production-triag-summary.json',
  )
  const safeTracePath = resolve(
    artifactRoot, 'production-triag-safe-trace.json',
  )
  const safeResults = new Map<
    ProductionScenarioName, ProductionSafeScenarioResult
  >(
    scenarioNames.map(scenario => [scenario, {
      scenario, status:'not_run', request_ids:[],
    }]),
  )
  const requestIds = new Map<ProductionScenarioName, string[]>()
  const freshChatStrategies = new Map<ProductionScenarioName, FreshChatStrategy>()
  const scenarioDiagnostics = new Map<
    ProductionScenarioName, Partial<ScenarioDiagnostics>
  >()
  const cleanupErrors: ProductionCleanupReasonCode[] = []
  const originalThreadIds = new Set<string>()
  const originalKnowledgeIds = new Set<string>()
  const generatedThreadIds = new Set<string>()
  const generatedKnowledgeIds = new Set<string>()
  const generatedRepositoryIds = new Set<string>()
  const generatedUploadIds = new Set<string>()
  let api: DeployedApi | null = null
  let authenticationSucceeded = false
  let snapshotsCaptured = false
  let productionMutationsBegan = false
  let threadMutationPossible = false
  let originalTier: 'lite' | 'standard' | 'pro' | null = null
  let cleanup: ProductionCleanup = { status:'not_required', reason_codes:[] }
  let preflight: ProductionSafeSummary['preflight'] = {
    status:'failed', reason_code:'bootstrap_not_observed',
  }
  let primaryFailureReason: ProductionPrimaryFailureReasonCode = 'none'
  let uploadId: string | null = null
  let uploadReady = false
  let rolloutReport: ProductionSafeSummary['rollout_report']
  const runMarker = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const unsupportedMarker = `ABSENT-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const factualValue = `TRIAG-${runMarker}`
  const recordRequest = (
    scenario: ProductionScenarioName,
    requestId: string,
  ) => {
    const values = requestIds.get(scenario) ?? []
    requestIds.set(scenario, [...values, requestId])
  }
  const recordAuditDiagnostics = (
    scenario: ProductionScenarioName,
    audit: AuditResult,
  ) => {
    scenarioDiagnostics.set(scenario, {
      ...scenarioDiagnostics.get(scenario),
      ...(audit.selected_tier === 'not_run'
        ? {} : { selected_tier:audit.selected_tier }),
      retrieval_status:audit.retrieval_status as ScenarioDiagnostics['retrieval_status'],
      quality_status:audit.quality_status as ScenarioDiagnostics['quality_status'],
      source_kind_counts:audit.source_kind_counts,
      answer_check_status_counts:audit.answer_check_status_counts,
      usage_stage_status_counts:audit.usage_stage_status_counts,
      active_usage_stage_names:audit.active_usage_stage_names,
      last_terminal_charge_status:audit.last_terminal_charge_status,
      repository_validation_mode:audit.repository_validation_mode,
      phase2_fallback_reason_code:audit.phase2_fallback_reason_code,
    })
  }
  const runScenario = async (
    scenario: ProductionScenarioName,
    action: () => Promise<void>,
  ) => {
    productionMutationsBegan = true
    threadMutationPossible = true
    await test.step(scenario, async () => {
      try {
        await action()
        safeResults.set(scenario, {
          scenario,
          status:'passed',
          request_ids:requestIds.get(scenario) ?? [],
          ...(freshChatStrategies.has(scenario)
            ? { fresh_chat_strategy:freshChatStrategies.get(scenario) } : {}),
          ...scenarioDiagnostics.get(scenario),
        })
      } catch (error) {
        const reasonCode = scenarioFailureReason[scenario]
        const scenarioError = error instanceof ProductionScenarioHarnessError
          ? error
          : new ProductionScenarioHarnessError(
            scenarioDefaultSubreason[scenario],
          )
        const freshChatStrategy = scenarioError.freshChatStrategy
          ?? freshChatStrategies.get(scenario)
        if (primaryFailureReason === 'none') primaryFailureReason = reasonCode
        safeResults.set(scenario, {
          scenario,
          status:'failed',
          request_ids:requestIds.get(scenario) ?? [],
          reason_code:reasonCode,
          subreason_code:scenarioError.reasonCode,
          ...(scenarioError.freshChatReasonCode
            ? { fresh_chat_reason_code:scenarioError.freshChatReasonCode } : {}),
          ...(freshChatStrategy
            ? { fresh_chat_strategy:freshChatStrategy } : {}),
          ...scenarioDiagnostics.get(scenario),
        })
      } finally {
        try {
          await safeScreenshot(page, screenshotDirectory, scenario)
        } catch {
          const current = safeResults.get(scenario)
          if (current?.status === 'passed') {
            const reasonCode = scenarioFailureReason[scenario]
            if (primaryFailureReason === 'none') primaryFailureReason = reasonCode
            safeResults.set(scenario, {
              scenario,
              status:'failed',
              request_ids:requestIds.get(scenario) ?? [],
              reason_code:reasonCode,
              subreason_code:'scenario_artifact_capture_failed',
              ...(freshChatStrategies.has(scenario)
                ? { fresh_chat_strategy:freshChatStrategies.get(scenario) } : {}),
              ...scenarioDiagnostics.get(scenario),
            })
          }
        }
      }
    })
  }

  try {
    if (process.env.PRODUCTION_TRIAG_CONFIRMATION !== WRITE_CONFIRMATION) {
      throw new SafeHarnessError('production_write_confirmation_missing')
    }
    const authenticated = await loginProductionTriag<Bootstrap>(
      page, email, password,
    )
    api = authenticated.api
    authenticationSucceeded = true
    preflight = { status:'passed', reason_code:authenticated.reasonCode }
    originalTier = authenticated.bootstrap.assistant.tier
    const initialThreads = await api.request<ThreadList>(
      'GET', '/api/web/threads?archived=false&limit=100&offset=0',
    ).catch(() => ({ status:0, data:null }))
    if (
      initialThreads.status !== 200
      || !initialThreads.data
      || initialThreads.data.has_more
    ) {
      throw new SafeHarnessError('thread_snapshot_failed')
    }
    const initialKnowledge = await api.request<{ items: KnowledgeDocument[] }>(
      'GET', '/api/web/knowledge',
    ).catch(() => ({ status:0, data:null }))
    if (initialKnowledge.status !== 200 || !initialKnowledge.data) {
      throw new SafeHarnessError('knowledge_snapshot_failed')
    }
    initialThreads.data.items.forEach(item => originalThreadIds.add(item.id))
    initialKnowledge.data.items.forEach(item => originalKnowledgeIds.add(item.id))
    snapshotsCaptured = true

    await runScenario('deterministic_greeting', async () => {
      freshChatStrategies.set(
        'deterministic_greeting', await newChat(page),
      )
      await safeScreenshot(
        page, screenshotDirectory, 'fresh_chat_ready',
      )
      let before: { available_micros: number } | null = null
      try {
        const wallet = await api!.request<{ available_micros: number }>(
          'GET', '/api/web/billing/wallet',
        )
        if (wallet.status !== 200 || !wallet.data) {
          throw new Error('bounded wallet read failure')
        }
        before = wallet.data
      } catch {
        throw new GreetingHarnessError('greeting_wallet_read_failed')
      }
      const sent = await sendMessage(page, 'Hi', {
        failureCodes:{
          requestNotObserved:'greeting_request_not_observed',
          requestIdMissing:'greeting_request_id_missing',
          assistantNotVisible:'greeting_assistant_not_visible',
          assistantNotComplete:'greeting_assistant_not_complete',
        },
        onRequestCaptured:(requestId, payload) => {
          recordRequest('deterministic_greeting', requestId)
          assertIsolatedGreetingPayload(payload)
        },
      })
      let responseText: string | null = null
      try {
        responseText = await sent.assistant.locator('.message-body')
          .textContent()
      } catch {
        throw new GreetingHarnessError('greeting_response_empty')
      }
      if (!responseText?.trim()) {
        throw new GreetingHarnessError('greeting_response_empty')
      }
      const result = await pollTerminalGreetingAudit<AuditResult>(
        api!, sent.requestId,
        { timeoutMilliseconds:30_000, intervalMilliseconds:500 },
      )
      recordAuditDiagnostics('deterministic_greeting', result)
      assertGreetingAudit(result)
      let after: { available_micros: number } | null = null
      try {
        const wallet = await api!.request<{ available_micros: number }>(
          'GET', '/api/web/billing/wallet',
        )
        if (wallet.status !== 200 || !wallet.data) {
          throw new Error('bounded wallet read failure')
        }
        after = wallet.data
      } catch {
        throw new GreetingHarnessError('greeting_wallet_read_failed')
      }
      if (after.available_micros !== before.available_micros) {
        throw new GreetingHarnessError('greeting_wallet_changed')
      }
    })

    if (safeResults.get('deterministic_greeting')?.status === 'passed') {
    await runScenario('supported_pdf', async () => {
      freshChatStrategies.set(
        'supported_pdf', await scenarioFreshChat(
          page, 'supported_pdf_fresh_chat_failed',
        ),
      )
      await selectProductionTier(
        page, api!, 'standard', 'supported_pdf_tier_selection_failed',
      )
      scenarioDiagnostics.set('supported_pdf', { selected_tier:'standard' })
      const uploadInput = page.getByLabel('Upload files')
      if (await uploadInput.count() !== 1) {
        scenarioFailure('supported_pdf_upload_input_missing')
      }
      const uploadResponse = page.waitForResponse(response => (
        new URL(response.url()).pathname === '/api/web/uploads'
        && response.request().method() === 'POST'
      ), { timeout:30_000 }).catch(() => null)
      try {
        await uploadInput.setInputFiles({
          name:'production-triag-document.pdf',
          mimeType:'application/pdf',
          buffer:productionTriagPdfFixture(factualValue),
        })
      } catch {
        scenarioFailure('supported_pdf_upload_input_missing')
      }
      const uploaded = await uploadResponse
      if (!uploaded) scenarioFailure('supported_pdf_upload_request_not_observed')
      const uploadStatus = uploaded.status()
      const uploadStatusFailure = supportedPdfUploadStatusSubreason(uploadStatus)
      if (uploadStatusFailure) scenarioFailure(uploadStatusFailure)
      let uploadedData: { id?: unknown }
      try {
        uploadedData = await uploaded.json() as { id?: unknown }
      } catch {
        scenarioFailure('supported_pdf_upload_response_invalid')
      }
      uploadId = typeof uploadedData.id === 'string'
        ? uploadedData.id : null
      if (!uploadId) scenarioFailure('supported_pdf_upload_id_missing')
      generatedUploadIds.add(uploadId)
      try {
        await expect(page.locator('.attachment-chip.ready')).toBeVisible({
          timeout:60_000,
        })
      } catch {
        scenarioFailure('supported_pdf_attachment_not_ready')
      }
      uploadReady = true
      const sent = await sendMessage(
        page,
        `Using only the attached PDF, what is the acceptance fact? ${runMarker}`,
        {
          failureCodes:{
            requestNotObserved:'supported_pdf_chat_request_not_observed',
            requestIdMissing:'supported_pdf_request_id_missing',
            assistantNotVisible:'supported_pdf_assistant_not_visible',
            assistantNotComplete:'supported_pdf_assistant_not_complete',
          },
          onRequestCaptured:requestId => {
            recordRequest('supported_pdf', requestId)
          },
        },
      )
      const result = await pollTerminalScenarioAudit(
        api!, sent.requestId, 'supported_pdf_audit_not_ready',
      )
      recordAuditDiagnostics('supported_pdf', result)
      try {
        await expect(sent.assistant.getByRole('region', { name:'Sources' }))
          .toBeVisible({ timeout:30_000 })
      } catch {
        scenarioFailure('supported_pdf_sources_not_visible')
      }
      if ((result.source_kind_counts.temporary_upload ?? 0) <= 0) {
        scenarioFailure('supported_pdf_document_source_missing')
      }
      if (result.retrieval_status !== 'sufficient') {
        scenarioFailure('supported_pdf_retrieval_not_sufficient')
      }
      if (!['grounded', 'verified'].includes(result.quality_status)) {
        scenarioFailure('supported_pdf_quality_not_grounded')
      }
    })

    if (uploadReady && uploadId) {
    await runScenario('unsupported_pdf', async () => {
      await selectProductionTier(
        page, api!, 'standard', 'unsupported_pdf_tier_selection_failed',
      )
      scenarioDiagnostics.set('unsupported_pdf', { selected_tier:'standard' })
      const sent = await sendMessage(
        page,
        `Using only the attached PDF, what launch city is stated? Do not use outside knowledge. ${unsupportedMarker}`,
        {
          failureCodes:{
            requestNotObserved:'unsupported_pdf_chat_request_not_observed',
            requestIdMissing:'unsupported_pdf_request_id_missing',
            assistantNotVisible:'unsupported_pdf_assistant_not_visible',
            assistantNotComplete:'unsupported_pdf_assistant_not_complete',
          },
          onRequestCaptured:requestId => {
            recordRequest('unsupported_pdf', requestId)
          },
        },
      )
      const result = await pollTerminalScenarioAudit(
        api!, sent.requestId, 'unsupported_pdf_audit_not_ready',
      )
      recordAuditDiagnostics('unsupported_pdf', result)
      if (result.quality_status !== 'insufficient_evidence') {
        scenarioFailure('unsupported_pdf_quality_invalid')
      }
      try {
        await expect(sent.assistant).toContainText(
          /not enough|does not (?:contain|provide|state)|is not (?:in|provided)|cannot (?:find|determine)/i,
        )
      } catch {
        scenarioFailure('unsupported_pdf_refusal_not_visible')
      }
    })

    await runScenario('knowledge_library', async () => {
      await selectProductionTier(
        page, api!, 'standard', 'knowledge_library_tier_selection_failed',
      )
      scenarioDiagnostics.set('knowledge_library', { selected_tier:'standard' })
      await openSidebar(page)
      await page.locator('.account-button').click()
      await page.getByRole('menuitem', { name:'Settings' }).click()
      const settings = page.getByRole('dialog', { name:'Settings' })
      await settings.getByRole('button', { name:'Knowledge Library' }).click()
      await settings.getByLabel('Uploaded document').selectOption(uploadId)
      await settings.getByLabel('Save to my Knowledge Library').check()
      const approvalResponse = page.waitForResponse(response => (
        new URL(response.url()).pathname === '/api/web/knowledge'
        && response.request().method() === 'POST'
        && response.status() === 201
      ))
      await settings.getByRole('button', { name:'Save document' }).click()
      const approval = await approvalResponse
      const approved = await approval.json() as KnowledgeResult
      const documentId = approved.document.id
      generatedKnowledgeIds.add(documentId)
      const deadline = Date.now() + 120_000
      let ready: KnowledgeResult | null = null
      while (Date.now() < deadline) {
        const status = await api!.request<KnowledgeResult>(
          'GET', `/api/web/knowledge/${encodeURIComponent(documentId)}`,
        )
        if (status.status !== 200 || !status.data) {
          scenarioFailure('knowledge_library_indexing_failed')
        }
        if (
          status.data.document.status === 'failed'
          || status.data.job.status === 'failed'
        ) {
          scenarioFailure('knowledge_library_indexing_failed')
        }
        if (status.data.document.status === 'ready') {
          ready = status.data
          break
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 2_000))
      }
      if (
        ready?.document.status !== 'ready'
        || ready.job.status === 'failed'
      ) scenarioFailure('knowledge_library_indexing_failed')
      await page.getByRole('button', { name:'Close settings' }).click()
      await page.locator('.attachment-chip.ready button').click()
      freshChatStrategies.set(
        'knowledge_library', await scenarioFreshChat(
          page, 'knowledge_library_fresh_chat_failed',
        ),
      )
      const sent = await sendMessage(
        page,
        `From my Knowledge Library, what is the acceptance fact? ${runMarker}`,
        {
          failureCodes:{
            requestNotObserved:'knowledge_library_chat_request_not_observed',
            requestIdMissing:'knowledge_library_request_id_missing',
            assistantNotVisible:'knowledge_library_assistant_not_visible',
            assistantNotComplete:'knowledge_library_assistant_not_complete',
          },
          onRequestCaptured:requestId => {
            recordRequest('knowledge_library', requestId)
          },
        },
      )
      const result = await pollTerminalScenarioAudit(
        api!, sent.requestId, 'knowledge_library_audit_not_ready',
      )
      recordAuditDiagnostics('knowledge_library', result)
      const knowledgeSources = (
        (result.source_kind_counts.persistent_knowledge ?? 0)
        + (result.source_kind_counts.approved_document ?? 0)
        + (result.source_kind_counts.knowledge_triplet ?? 0)
      )
      if (knowledgeSources <= 0) {
        scenarioFailure('knowledge_library_source_missing')
      }
      if (!['grounded', 'verified'].includes(result.quality_status)) {
        scenarioFailure('knowledge_library_quality_invalid')
      }
      await deleteGeneratedKnowledgeDocument(
        api!, documentId, originalKnowledgeIds,
      )
      generatedKnowledgeIds.delete(documentId)
    })
    } else {
      for (const scenario of [
        'unsupported_pdf', 'knowledge_library',
      ] as const) {
        safeResults.set(scenario, {
          scenario,
          status:'not_run',
          request_ids:[],
          prerequisite_reason_code:'supported_pdf_prerequisite_failed',
        })
      }
    }

    await runScenario('repository_pro', async () => {
      freshChatStrategies.set(
        'repository_pro', await scenarioFreshChat(
          page, 'repository_fresh_chat_failed',
        ),
      )
      await selectProductionTier(
        page, api!, 'pro', 'repository_tier_selection_failed',
      )
      scenarioDiagnostics.set('repository_pro', { selected_tier:'pro' })
      const repositoryInput = page.getByLabel('Upload code repository')
      if (await repositoryInput.count() !== 1) {
        scenarioFailure('repository_upload_input_missing')
      }
      const repositoryResponse = page.waitForResponse(response => (
        new URL(response.url()).pathname === '/api/web/repositories'
        && response.request().method() === 'POST'
      ), { timeout:30_000 }).catch(() => null)
      try {
        await repositoryInput.setInputFiles({
          name:'production-triag-repository.zip',
          mimeType:'application/zip',
          buffer:repositoryZip(),
        })
      } catch {
        scenarioFailure('repository_upload_input_missing')
      }
      const repositoryUpload = await repositoryResponse
      if (!repositoryUpload) {
        scenarioFailure('repository_upload_request_not_observed')
      }
      if (![200, 201].includes(repositoryUpload.status())) {
        scenarioFailure('repository_upload_http_failure')
      }
      let repository: { id?: unknown }
      try {
        repository = await repositoryUpload.json() as { id?: unknown }
      } catch {
        scenarioFailure('repository_upload_http_failure')
      }
      if (typeof repository.id !== 'string' || !repository.id) {
        scenarioFailure('repository_upload_http_failure')
      }
      generatedRepositoryIds.add(repository.id)
      try {
        await expect(page.getByText('Static checks only', { exact:true }))
          .toBeVisible({ timeout:60_000 })
      } catch {
        scenarioFailure('repository_not_ready')
      }
      if (
        authenticated.bootstrap.repositories.validation_capability
        !== 'static_only'
      ) scenarioFailure('repository_static_only_label_missing')
      const sent = await sendMessage(
        page,
        `Correct the clear bug in the uploaded repository and explain the change. ${runMarker}`,
        {
          failureCodes:{
            requestNotObserved:'repository_chat_request_not_observed',
            requestIdMissing:'repository_request_id_missing',
            assistantNotVisible:'repository_assistant_not_visible',
            assistantNotComplete:'repository_assistant_not_complete',
          },
          onRequestCaptured:requestId => {
            recordRequest('repository_pro', requestId)
          },
        },
      )
      const result = await pollTerminalScenarioAudit(
        api!, sent.requestId, 'repository_audit_not_ready', 45_000,
        lastObserved => recordAuditDiagnostics('repository_pro', lastObserved),
      )
      recordAuditDiagnostics('repository_pro', result)
      try {
        await expect(sent.assistant.getByRole('region', {
          name:'Response quality',
        })).toBeVisible({ timeout:30_000 })
      } catch {
        scenarioFailure('repository_quality_not_visible')
      }
      try {
        await expect(sent.assistant.getByText(/Static checks only/)).toBeVisible()
        await expect(sent.assistant).not.toContainText(
          /Repository verified|Executable validation available/i,
        )
      } catch {
        scenarioFailure('repository_static_only_label_missing')
      }
      if ((result.source_kind_counts.repository ?? 0) <= 0) {
        scenarioFailure('repository_source_missing')
      }
      if (!['grounded', 'unverified'].includes(result.quality_status)) {
        scenarioFailure('repository_quality_invalid')
      }
    })

    await runScenario('cancellation_settlement', async () => {
      let cancelled: AuditResult | null = null
      await selectProductionTier(
        page, api!, 'pro', 'cancellation_tier_selection_failed',
      )
      scenarioDiagnostics.set('cancellation_settlement', {
        selected_tier:'pro',
      })
      const cancellationMarker = (
        `CANCEL-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
      )
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        freshChatStrategies.set(
          'cancellation_settlement', await scenarioFreshChat(
            page, 'cancellation_fresh_chat_failed',
          ),
        )
        const sent = await sendMessage(
          page,
          (
            `Analyze lock-free concurrency, backpressure, fairness, and `
            + `failure recovery in a hypothetical distributed scheduler. `
            + `Provide a deep Pro-level technical review with alternatives, `
            + `trade-offs, and pseudocode. Attempt ${attempt}. `
            + `${cancellationMarker} `
          ).repeat(18),
          {
            waitForCompletion:false,
            failureCodes:{
              requestNotObserved:'cancellation_request_not_observed',
              requestIdMissing:'cancellation_request_id_missing',
              assistantNotVisible:'cancellation_assistant_not_visible',
              assistantNotComplete:'cancellation_not_reached',
            },
            onRequestCaptured:requestId => {
              recordRequest('cancellation_settlement', requestId)
            },
          },
        )
        try {
          await pollAudit(
            api!, sent.requestId,
            value => value.cancellation_state === 'active' && (
              value.active_usage_stage_names.length > 0
              || ['reserving', 'reserved', 'exempt_pending'].some(
                status => (value.charge_status_counts[status] ?? 0) > 0,
              )
            ),
            15_000,
          )
        } catch (error) {
          if (
            error instanceof AuditPollingError
            && error.lastObserved?.cancellation_state === 'complete'
          ) {
            recordAuditDiagnostics(
              'cancellation_settlement', error.lastObserved,
            )
            continue
          }
          scenarioFailure('cancellation_audit_not_ready')
        }
        const stop = page.getByTestId('stop-generation-button')
        try {
          await expect(stop).toHaveAttribute(
            'data-cancellation-ready', 'true', { timeout:30_000 },
          )
          const cancellationResponse = page.waitForResponse(response => (
            new URL(response.url()).pathname
              === `/api/web/chat/requests/${sent.requestId}/cancel`
            && response.request().method() === 'POST'
          ), { timeout:30_000 }).catch(() => null)
          await stop.click()
          const observed = await cancellationResponse
          let responseStatus = ''
          if (observed) {
            try {
              const body = await observed.json() as { status?: unknown }
              responseStatus = typeof body.status === 'string'
                ? body.status : ''
            } catch {
              responseStatus = ''
            }
          }
          scenarioDiagnostics.set('cancellation_settlement', {
            ...scenarioDiagnostics.get('cancellation_settlement'),
            cancellation_attempt_http_result:observed
              ? observed.status() === 200 ? 'http_200' : 'http_non_200'
              : 'not_observed',
          })
          if (
            !observed
            || observed.status() !== 200
            || !['stopped', 'cancelling'].includes(responseStatus)
          ) scenarioFailure('cancellation_not_reached')
        } catch {
          scenarioFailure('cancellation_stop_button_unavailable')
        }
        let result: AuditResult
        try {
          result = await pollAudit(
            api!,
            sent.requestId,
            value => value.cancellation_state !== 'active',
            45_000,
          )
        } catch {
          scenarioFailure('cancellation_audit_not_ready')
        }
        recordAuditDiagnostics('cancellation_settlement', result)
        scenarioDiagnostics.set('cancellation_settlement', {
          ...scenarioDiagnostics.get('cancellation_settlement'),
          cancellation_observed_audit_state:
            result.cancellation_state as ScenarioDiagnostics['cancellation_observed_audit_state'],
        })
        if (result.cancellation_state === 'cancelled') {
          cancelled = result
          break
        }
        scenarioFailure('cancellation_not_reached')
      }
      if (!cancelled) scenarioFailure('cancellation_not_reached')
      if (
        cancelled.usage_charge_row_count !== 1
        || cancelled.duplicate_settlement_indicator !== false
      ) scenarioFailure('cancellation_duplicate_charge')
      if (cancelled.orphaned_active_reservation !== false) {
        scenarioFailure('cancellation_orphaned_reservation')
      }
      if (cancelled.cancellation_failure_count !== 0) {
        scenarioFailure('cancellation_settlement_mismatch')
      }
      if (
        cancelled.active_usage_stage_names.length > 0
        || ['planned', 'reserved', 'running'].some(
          status => (cancelled.usage_stage_status_counts[status] ?? 0) > 0,
        )
      ) scenarioFailure('cancellation_settlement_mismatch')
      if (cancelled.charged_micro_inr_total > 0 && (
        cancelled.charge_status_counts.settled !== 1
        || cancelled.settled_micro_inr_total
          !== cancelled.charged_micro_inr_total
      )) {
        scenarioFailure('cancellation_settlement_mismatch')
      }
    })
    } else {
      for (const scenario of scenarioNames.slice(1)) {
        safeResults.set(scenario, {
          scenario,
          status:'not_run',
          request_ids:[],
          prerequisite_reason_code:'deterministic_greeting_prerequisite_failed',
        })
      }
    }
  } catch (error) {
    if (error instanceof ProductionPreflightError) {
      preflight = { status:'failed', reason_code:error.reasonCode }
      primaryFailureReason = error.reasonCode
      authenticationSucceeded = error.authenticationSucceeded
      api = error.api
    } else if (error instanceof SafeHarnessError) {
      primaryFailureReason = error.reasonCode
    } else if (primaryFailureReason === 'none') {
      primaryFailureReason = 'unexpected_harness_failure'
    }
  } finally {
    if (api && authenticationSucceeded && productionMutationsBegan) {
      const captured = await api.request<NonNullable<
        ProductionSafeSummary['rollout_report']
      >>(
        'GET', '/api/web/admin/triag-rollout-report',
      ).catch(() => ({ status:0, data:null }))
      if (
        captured.status === 200
        && captured.data
        && Array.isArray(captured.data.groups)
      ) {
        rolloutReport = captured.data
      } else if (primaryFailureReason === 'none') {
        primaryFailureReason = 'unexpected_harness_failure'
      }
    }
    if (api && snapshotsCaptured && productionMutationsBegan) {
      if (threadMutationPossible) {
        const currentThreads = await api.request<ThreadList>(
          'GET', '/api/web/threads?archived=false&limit=100&offset=0',
        ).catch(() => ({ status:0, data:null }))
        if (
          currentThreads.status === 200
          && currentThreads.data
          && !currentThreads.data.has_more
        ) {
          for (const thread of currentThreads.data.items) {
            if (!originalThreadIds.has(thread.id)) {
              generatedThreadIds.add(thread.id)
            }
          }
          for (const threadId of generatedThreadIds) {
            try {
              await deleteGeneratedThread(
                api, threadId, originalThreadIds, generatedThreadIds,
              )
            } catch (error) {
              cleanupErrors.push(
                error instanceof ThreadCleanupError
                  ? error.reasonCode : 'thread_delete_http_failure',
              )
            }
          }
          const verifiedThreads = await api.request<ThreadList>(
            'GET', '/api/web/threads?archived=false&limit=100&offset=0',
          ).catch(() => ({ status:0, data:null }))
          const verifiedIds = new Set(
            verifiedThreads.data?.items.map(item => item.id) ?? [],
          )
          if (
            verifiedThreads.status !== 200
            || !verifiedThreads.data
            || verifiedThreads.data.has_more
            || verifiedIds.size !== originalThreadIds.size
            || [...originalThreadIds].some(id => !verifiedIds.has(id))
          ) cleanupErrors.push('thread_verification_failed')
        } else {
          cleanupErrors.push('thread_discovery_failed')
        }
      }
      for (const documentId of generatedKnowledgeIds) {
        try {
          await deleteGeneratedKnowledgeDocument(
            api, documentId, originalKnowledgeIds,
          )
        } catch {
          cleanupErrors.push('knowledge_delete_failed')
        }
      }
      for (const repositoryId of generatedRepositoryIds) {
        try {
          await deleteGeneratedRepository(api, repositoryId)
        } catch {
          cleanupErrors.push('repository_delete_failed')
        }
      }
      for (const uploadId of generatedUploadIds) {
        try {
          await deleteGeneratedUpload(api, uploadId)
        } catch {
          cleanupErrors.push('upload_delete_failed')
        }
      }
      if (originalTier) {
        try {
          const restored = await api.request<{ tier: string }>(
            'PATCH', '/api/web/settings/assistant', { tier:originalTier },
          )
          const verified = await api.request<{ tier: string }>(
            'GET', '/api/web/settings/assistant',
          )
          if (
            restored.status !== 200
            || verified.status !== 200
            || verified.data?.tier !== originalTier
          ) cleanupErrors.push('tier_restore_failed')
        } catch {
          cleanupErrors.push('tier_restore_failed')
        }
      }
    }
    if (authenticationSucceeded) {
      try {
        await logoutDeployed(page)
      } catch {
        cleanupErrors.push('logout_failed')
      }
    }
    cleanup = resolveProductionCleanup(
      authenticationSucceeded,
      productionMutationsBegan,
      cleanupErrors,
    )
  }
  const scenarios = scenarioNames.map(name => (
    safeResults.get(name) ?? {
      scenario:name, status:'not_run' as const, request_ids:[],
    }
  ))
  const summary = buildProductionTriagSummary({
    preflight,
    scenarios,
    cleanup,
    primaryFailureReasonCode:primaryFailureReason,
    rolloutReport,
  })
  await mkdir(artifactRoot, { recursive:true })
  const serialized = `${JSON.stringify(summary, null, 2)}\n`
  await writeFile(summaryPath, serialized, 'utf8')
  await writeFile(safeTracePath, serialized, 'utf8')
  if (primaryFailureReason !== 'none' || cleanup.status === 'incomplete') {
    console.error(
      'production-triag.spec.ts reason_code=%s cleanup_status=%s',
      primaryFailureReason,
      cleanup.status,
    )
    throw new Error(boundedCombinedFailure(primaryFailureReason, cleanup))
  }
})
