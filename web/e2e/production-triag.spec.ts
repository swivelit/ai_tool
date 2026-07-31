import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  deleteGeneratedKnowledgeDocument,
  deleteGeneratedRepository,
  deleteGeneratedThread,
  deleteGeneratedUpload,
  loginDeployed,
  logoutDeployed,
  type DeployedApi,
} from '../src/testing/deployedSafety'

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
  paid_usage_stage_count: number
  duplicate_settlement_indicator: boolean
  source_count: number
  source_kind_counts: Record<string, number>
  retrieval_status: string
  quality_status: string
  answer_check_status_counts: Record<string, number>
  cancellation_state: string
  cancellation_failure_count: number
  orphaned_active_reservation: boolean
}
type ScenarioName =
  | 'deterministic_greeting'
  | 'supported_pdf'
  | 'unsupported_pdf'
  | 'knowledge_library'
  | 'repository_pro'
  | 'cancellation_settlement'
type SafeScenarioResult = {
  scenario: ScenarioName
  status: 'passed' | 'failed' | 'not_run'
  request_ids: string[]
}
type SafeSummary = {
  schema_version: 1
  result: 'passed' | 'failed'
  scenarios: SafeScenarioResult[]
  cleanup: 'complete' | 'incomplete'
}

const scenarioNames: ScenarioName[] = [
  'deterministic_greeting',
  'supported_pdf',
  'unsupported_pdf',
  'knowledge_library',
  'repository_pro',
  'cancellation_settlement',
]

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

function pdfFixture(factualValue: string): Buffer {
  const escaped = factualValue.replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(').replaceAll(')', '\\)')
  const stream = `BT /F1 12 Tf 72 720 Td (Acceptance fact: ${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map(value => (
    `${String(value).padStart(10, '0')} 00000 n \n`
  )).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body)
}

async function openSidebar(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name:'Open sidebar' })
  if (await trigger.isVisible()) await trigger.click()
}

async function newChat(page: Page): Promise<void> {
  await openSidebar(page)
  await page.getByRole('button', { name:'New chat' }).click()
}

async function sendMessage(
  page: Page,
  message: string,
  options: { waitForCompletion?: boolean } = {},
): Promise<{ requestId: string; assistant: Locator }> {
  const observed = page.waitForRequest(request => (
    new URL(request.url()).pathname === '/api/web/chat/stream'
    && request.method() === 'POST'
  ))
  await page.getByLabel('Message Swico').fill(message)
  await page.getByRole('button', { name:'Send message' }).click()
  const request = await observed
  const requestId = String(
    (request.postDataJSON() as { request_id?: unknown }).request_id ?? '',
  )
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new Error('Production request identifier was not captured')
  }
  const assistant = page.locator(
    `.message.assistant[data-request-id="${requestId}"]`,
  )
  await expect(assistant).toBeVisible({ timeout:90_000 })
  if (options.waitForCompletion !== false) {
    await expect(assistant).not.toHaveClass(/streaming/, { timeout:180_000 })
  }
  return { requestId, assistant }
}

async function audit(
  api: DeployedApi,
  requestIds: string[],
): Promise<AuditResult[]> {
  const result = await api.request<{ results: AuditResult[] }>(
    'POST',
    '/api/web/admin/triag-request-audit',
    { request_ids:requestIds },
  )
  if (result.status !== 200 || !result.data) {
    throw new Error('TRIAG request audit was unavailable')
  }
  return result.data.results
}

async function pollAudit(
  api: DeployedApi,
  requestId: string,
  predicate: (value: AuditResult) => boolean,
  timeoutMilliseconds = 30_000,
): Promise<AuditResult> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const response = await api.request<{ results: AuditResult[] }>(
      'POST', '/api/web/admin/triag-request-audit',
      { request_ids:[requestId] },
    )
    const current = response.status === 200
      ? response.data?.results[0] : undefined
    if (current && predicate(current)) return current
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error('TRIAG request audit did not reach the expected state')
}

async function safeScreenshot(
  page: Page,
  directory: string,
  scenario: ScenarioName,
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
  if (process.env.PRODUCTION_TRIAG_CONFIRMATION !== WRITE_CONFIRMATION) {
    throw new Error('Exact production write confirmation is required')
  }
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
  const safeResults = new Map<ScenarioName, SafeScenarioResult>(
    scenarioNames.map(scenario => [scenario, {
      scenario, status:'not_run', request_ids:[],
    }]),
  )
  const requestIds = new Map<ScenarioName, string[]>()
  const cleanupErrors: string[] = []
  const originalThreadIds = new Set<string>()
  const originalKnowledgeIds = new Set<string>()
  const generatedKnowledgeIds = new Set<string>()
  const generatedRepositoryIds = new Set<string>()
  const generatedUploadIds = new Set<string>()
  let api: DeployedApi | null = null
  let threadSnapshotCaptured = false
  let originalTier: 'lite' | 'standard' | 'pro' | null = null
  let cleanup: SafeSummary['cleanup'] = 'incomplete'
  const scenarioFailures: ScenarioName[] = []
  let uploadId: string | null = null
  const runMarker = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const factualValue = `TRIAG-${runMarker}`
  const recordRequest = (scenario: ScenarioName, requestId: string) => {
    const values = requestIds.get(scenario) ?? []
    requestIds.set(scenario, [...values, requestId])
  }
  const runScenario = async (
    scenario: ScenarioName,
    action: () => Promise<void>,
  ) => {
    await test.step(scenario, async () => {
      try {
        await action()
        safeResults.set(scenario, {
          scenario,
          status:'passed',
          request_ids:requestIds.get(scenario) ?? [],
        })
      } catch {
        scenarioFailures.push(scenario)
        safeResults.set(scenario, {
          scenario,
          status:'failed',
          request_ids:requestIds.get(scenario) ?? [],
        })
      } finally {
        try {
          await safeScreenshot(page, screenshotDirectory, scenario)
        } catch {
          if (!scenarioFailures.includes(scenario)) {
            scenarioFailures.push(scenario)
            safeResults.set(scenario, {
              scenario,
              status:'failed',
              request_ids:requestIds.get(scenario) ?? [],
            })
          }
        }
      }
    })
  }

  try {
    const authenticated = await loginDeployed<Bootstrap>(
      page, email, password,
    )
    api = authenticated.api
    originalTier = authenticated.bootstrap.assistant.tier
    expect(
      authenticated.bootstrap.wallet.billing_exempt,
      'Production TRIAG requires the dedicated internal account',
    ).toBe(true)
    expect(authenticated.bootstrap.features).toMatchObject({
      web_attachments:true,
      web_knowledge_library:true,
      web_repository_upload:true,
      web_repository_chat:true,
    })
    const initialThreads = await api.request<ThreadList>(
      'GET', '/api/web/threads?archived=false&limit=100&offset=0',
    )
    const initialKnowledge = await api.request<{ items: KnowledgeDocument[] }>(
      'GET', '/api/web/knowledge',
    )
    if (
      initialThreads.status !== 200
      || !initialThreads.data
      || initialThreads.data.has_more
    ) {
      throw new Error('Production thread snapshot failed')
    }
    if (initialKnowledge.status !== 200 || !initialKnowledge.data) {
      throw new Error('Production knowledge snapshot failed')
    }
    initialThreads.data.items.forEach(item => originalThreadIds.add(item.id))
    threadSnapshotCaptured = true
    initialKnowledge.data.items.forEach(item => originalKnowledgeIds.add(item.id))

    await runScenario('deterministic_greeting', async () => {
      const before = await api!.request<{
        available_micros: number
      }>('GET', '/api/web/billing/wallet')
      expect(before.status).toBe(200)
      const sent = await sendMessage(page, 'Hi')
      recordRequest('deterministic_greeting', sent.requestId)
      await expect(sent.assistant.locator('.message-body')).not.toBeEmpty()
      const after = await api!.request<{
        available_micros: number
      }>('GET', '/api/web/billing/wallet')
      expect(after.status).toBe(200)
      expect(after.data?.available_micros).toBe(before.data?.available_micros)
      const result = (await audit(api!, [sent.requestId]))[0]
      expect(result.provider_call_count).toBe(0)
      expect(result.charged_micro_inr_total).toBe(0)
      expect(result.settled_micro_inr_total).toBe(0)
      expect(result.paid_usage_stage_count).toBe(0)
      expect(result.duplicate_settlement_indicator).toBe(false)
    })

    await runScenario('supported_pdf', async () => {
      await newChat(page)
      const uploadResponse = page.waitForResponse(response => (
        new URL(response.url()).pathname === '/api/web/uploads'
        && response.request().method() === 'POST'
        && response.status() === 201
      ))
      await page.getByLabel('Upload files').setInputFiles({
        name:'production-triag-document.pdf',
        mimeType:'application/pdf',
        buffer:pdfFixture(factualValue),
      })
      const uploaded = await uploadResponse
      uploadId = String(
        (await uploaded.json() as { id?: unknown }).id ?? '',
      )
      if (!uploadId) throw new Error('Production document upload failed')
      generatedUploadIds.add(uploadId)
      await expect(page.locator('.attachment-chip.ready')).toBeVisible({
        timeout:60_000,
      })
      const sent = await sendMessage(
        page,
        `Using only the attached PDF, what is the acceptance fact? ${runMarker}`,
      )
      recordRequest('supported_pdf', sent.requestId)
      await expect(sent.assistant.getByRole('region', { name:'Sources' }))
        .toBeVisible()
      const result = (await audit(api!, [sent.requestId]))[0]
      expect(result.source_kind_counts.temporary_upload ?? 0).toBeGreaterThan(0)
      expect(result.retrieval_status).toBe('sufficient')
      expect(['grounded', 'verified']).toContain(result.quality_status)
    })

    await runScenario('unsupported_pdf', async () => {
      if (!uploadId) throw new Error('Required production fixture is unavailable')
      const sent = await sendMessage(
        page,
        `Using only the attached PDF, what launch city is stated? Do not use outside knowledge. ${runMarker}`,
      )
      recordRequest('unsupported_pdf', sent.requestId)
      const result = (await audit(api!, [sent.requestId]))[0]
      expect(result.quality_status).toBe('insufficient_evidence')
      await expect(sent.assistant).toContainText(
        /not enough|does not (?:contain|provide|state)|is not (?:in|provided)|cannot (?:find|determine)/i,
      )
    })

    await runScenario('knowledge_library', async () => {
      if (!uploadId) throw new Error('Required production fixture is unavailable')
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
          throw new Error('Knowledge document status was unavailable')
        }
        if (
          status.data.document.status === 'failed'
          || status.data.job.status === 'failed'
        ) {
          throw new Error('Knowledge indexing reported failure')
        }
        if (status.data.document.status === 'ready') {
          ready = status.data
          break
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 2_000))
      }
      expect(ready?.document.status).toBe('ready')
      expect(ready?.job.status).not.toBe('failed')
      await page.getByRole('button', { name:'Close settings' }).click()
      await page.locator('.attachment-chip.ready button').click()
      await newChat(page)
      const sent = await sendMessage(
        page,
        `From my Knowledge Library, what is the acceptance fact? ${runMarker}`,
      )
      recordRequest('knowledge_library', sent.requestId)
      const result = (await audit(api!, [sent.requestId]))[0]
      const knowledgeSources = (
        (result.source_kind_counts.persistent_knowledge ?? 0)
        + (result.source_kind_counts.approved_document ?? 0)
        + (result.source_kind_counts.knowledge_triplet ?? 0)
      )
      expect(knowledgeSources).toBeGreaterThan(0)
      expect(['grounded', 'verified']).toContain(result.quality_status)
    })

    await runScenario('repository_pro', async () => {
      await newChat(page)
      const tier = page.locator('.tier-selector-composer')
      await tier.getByRole('button', { name:/Swico/ }).click()
      await tier.getByRole('option', { name:/Swico Pro/ }).click()
      await expect(tier.getByRole('button', { name:/Swico Pro/ }))
        .toBeVisible({ timeout:30_000 })
      const repositoryResponse = page.waitForResponse(response => (
        new URL(response.url()).pathname === '/api/web/repositories'
        && response.request().method() === 'POST'
        && [200, 201].includes(response.status())
      ))
      await page.getByLabel('Upload code repository').setInputFiles({
        name:'production-triag-repository.zip',
        mimeType:'application/zip',
        buffer:repositoryZip(),
      })
      const repositoryUpload = await repositoryResponse
      const repository = await repositoryUpload.json() as { id: string }
      generatedRepositoryIds.add(repository.id)
      await expect(page.getByText('Static checks only', { exact:true }))
        .toBeVisible({ timeout:60_000 })
      expect(authenticated.bootstrap.repositories.validation_capability)
        .toBe('static_only')
      const sent = await sendMessage(
        page,
        `Correct the clear bug in the uploaded repository and explain the change. ${runMarker}`,
      )
      recordRequest('repository_pro', sent.requestId)
      await expect(sent.assistant.getByRole('region', {
        name:'Response quality',
      })).toBeVisible()
      await expect(sent.assistant.getByText(/Static checks only/)).toBeVisible()
      await expect(sent.assistant).not.toContainText(/Repository verified|Executable validation available/i)
      const result = (await audit(api!, [sent.requestId]))[0]
      expect(result.source_kind_counts.repository ?? 0).toBeGreaterThan(0)
      expect(['grounded', 'unverified']).toContain(result.quality_status)
    })

    await runScenario('cancellation_settlement', async () => {
      let cancelled: AuditResult | null = null
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await newChat(page)
        const sent = await sendMessage(
          page,
          `Produce a detailed ${attempt}-part technical review with extensive reasoning and examples. ${runMarker} `.repeat(20),
          { waitForCompletion:false },
        )
        recordRequest('cancellation_settlement', sent.requestId)
        const stop = page.getByRole('button', { name:'Stop generation' })
        if (await stop.isVisible()) await stop.click()
        const result = await pollAudit(
          api!,
          sent.requestId,
          value => value.cancellation_state !== 'active',
          45_000,
        )
        if (result.cancellation_state === 'cancelled') {
          cancelled = result
          break
        }
      }
      expect(cancelled, 'At least one bounded attempt must be cancelled')
        .not.toBeNull()
      expect(cancelled!.usage_charge_row_count).toBe(1)
      expect(cancelled!.duplicate_settlement_indicator).toBe(false)
      expect(cancelled!.orphaned_active_reservation).toBe(false)
      expect(cancelled!.cancellation_failure_count).toBe(0)
      if (cancelled!.charged_micro_inr_total > 0) {
        expect(cancelled!.charge_status_counts.settled).toBe(1)
        expect(cancelled!.settled_micro_inr_total)
          .toBe(cancelled!.charged_micro_inr_total)
      }
    })
    expect(
      scenarioFailures,
      'Every production TRIAG scenario must pass',
    ).toEqual([])
  } finally {
    if (api) {
      if (threadSnapshotCaptured) {
        const currentThreads = await api.request<ThreadList>(
          'GET', '/api/web/threads?archived=false&limit=100&offset=0',
        ).catch(() => ({ status:0, data:null }))
        if (
          currentThreads.status === 200
          && currentThreads.data
          && !currentThreads.data.has_more
        ) {
          for (const thread of currentThreads.data.items) {
            if (originalThreadIds.has(thread.id)) continue
            try {
              await deleteGeneratedThread(api, thread.id, originalThreadIds)
            } catch {
              cleanupErrors.push('thread')
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
          ) cleanupErrors.push('thread_verification')
        } else {
          cleanupErrors.push('thread_snapshot')
        }
      } else {
        cleanupErrors.push('thread_snapshot')
      }
      for (const documentId of generatedKnowledgeIds) {
        try {
          await deleteGeneratedKnowledgeDocument(
            api, documentId, originalKnowledgeIds,
          )
        } catch {
          cleanupErrors.push('knowledge')
        }
      }
      for (const repositoryId of generatedRepositoryIds) {
        try {
          await deleteGeneratedRepository(api, repositoryId)
        } catch {
          cleanupErrors.push('repository')
        }
      }
      for (const uploadId of generatedUploadIds) {
        try {
          await deleteGeneratedUpload(api, uploadId)
        } catch {
          cleanupErrors.push('upload')
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
          ) cleanupErrors.push('tier')
        } catch {
          cleanupErrors.push('tier')
        }
      }
    } else {
      cleanupErrors.push('authentication')
    }
    try {
      await logoutDeployed(page)
    } catch {
      cleanupErrors.push('logout')
    }
    cleanup = cleanupErrors.length === 0 ? 'complete' : 'incomplete'
    const scenarios = scenarioNames.map(name => (
      safeResults.get(name) ?? {
        scenario:name, status:'not_run' as const, request_ids:[],
      }
    ))
    const summary: SafeSummary = {
      schema_version:1,
      result: scenarios.every(item => item.status === 'passed')
        && cleanup === 'complete' ? 'passed' : 'failed',
      scenarios,
      cleanup,
    }
    await mkdir(artifactRoot, { recursive:true })
    const serialized = `${JSON.stringify(summary, null, 2)}\n`
    await writeFile(summaryPath, serialized, 'utf8')
    await writeFile(safeTracePath, serialized, 'utf8')
    expect(cleanupErrors, 'Production TRIAG cleanup must be complete')
      .toEqual([])
  }
})
