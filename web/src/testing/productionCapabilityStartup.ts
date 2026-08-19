import {
  DeployedApiTransportError,
  type ApiResult,
  type DeployedApi,
  type RestorableProfile,
} from './deployedSafety'

export type StartupSnapshotStep =
  | 'active_threads'
  | 'archived_threads'
  | 'profile'
  | 'memory'
  | 'knowledge'
  | 'wallet'
  | 'ledger'

export type StartupSnapshotReasonCode =
  | 'active_thread_snapshot_failed'
  | 'archived_thread_snapshot_failed'
  | 'profile_snapshot_failed'
  | 'memory_snapshot_failed'
  | 'knowledge_snapshot_failed'
  | 'wallet_snapshot_failed'
  | 'ledger_snapshot_failed'
  | 'startup_response_shape_invalid'
  | 'startup_api_timeout'
  | 'startup_api_unauthorized'
  | 'startup_api_forbidden'

export type StartupMemorySettings = {
  available: boolean
  enabled: boolean
  items: Array<{ id: string; value_text: string }>
}

export type ProductionAccountSnapshot = {
  tier: 'lite' | 'standard' | 'pro'
  activeThreadIds: string[]
  archivedThreadIds: string[]
  profile: RestorableProfile
  memory: StartupMemorySettings
  knowledgeDocumentIds: string[]
  walletValues: { chat: number; voice: number }
  latestLedgerId: string | null
}

export type StartupFailureDiagnostic = {
  failing_startup_step: StartupSnapshotStep
  safe_reason_code: StartupSnapshotReasonCode
  http_status: number | null
  returned_content_type: string
  safe_response_shape_keys: string[]
  error_class: string
  repository_file: 'web/src/testing/productionCapabilityStartup.ts'
  repository_line: number
}

export class StartupSnapshotError extends Error {
  readonly diagnostic: StartupFailureDiagnostic
  readonly reasonCode: StartupSnapshotReasonCode

  constructor(diagnostic: StartupFailureDiagnostic) {
    super(diagnostic.safe_reason_code)
    this.name = 'StartupSnapshotError'
    this.diagnostic = diagnostic
    this.reasonCode = diagnostic.safe_reason_code
  }
}

type SnapshotOptions = {
  api: DeployedApi
  tier: 'lite' | 'standard' | 'pro'
  knowledgeEnabled: boolean
  onProgress?: (
    state: 'start' | 'complete', step: StartupSnapshotStep | 'all',
  ) => void
  onFailureDiagnostic?: (diagnostic: StartupFailureDiagnostic) => Promise<void>
  requestTimeoutMilliseconds?: number
  retryDelayMilliseconds?: number
  wait?: (milliseconds: number) => Promise<void>
}

const STEP_FAILURE: Record<StartupSnapshotStep, StartupSnapshotReasonCode> = {
  active_threads:'active_thread_snapshot_failed',
  archived_threads:'archived_thread_snapshot_failed',
  profile:'profile_snapshot_failed',
  memory:'memory_snapshot_failed',
  knowledge:'knowledge_snapshot_failed',
  wallet:'wallet_snapshot_failed',
  ledger:'ledger_snapshot_failed',
}

const UUIDISH_ID = /^[0-9a-z-]{1,80}$/i
const SAFE_SHAPE_KEY = /^[a-z][a-z0-9_]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeShapeKeys(value: unknown): string[] {
  if (!isRecord(value)) return []
  return Object.keys(value)
    .filter(key => SAFE_SHAPE_KEY.test(key))
    .sort()
    .slice(0, 24)
}

function safeContentType(value: string | null | undefined): string {
  const mediaType = String(value ?? '').split(';', 1)[0].trim().toLowerCase()
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType)
    ? mediaType : 'unknown'
}

function sourceLine(error: Error): number {
  const match = error.stack?.match(/productionCapabilityStartup\.ts:(\d+):\d+/)
  const line = Number(match?.[1] ?? 1)
  return Number.isInteger(line) && line > 0 ? line : 1
}

function diagnostic(
  step: StartupSnapshotStep,
  reasonCode: StartupSnapshotReasonCode,
  result: ApiResult<unknown> | null,
  cause: unknown,
): StartupFailureDiagnostic {
  const marker = new Error(reasonCode)
  return {
    failing_startup_step:step,
    safe_reason_code:reasonCode,
    http_status:Number.isInteger(result?.status) ? result!.status : null,
    returned_content_type:safeContentType(result?.contentType),
    safe_response_shape_keys:safeShapeKeys(result?.data),
    error_class:cause instanceof DeployedApiTransportError
      ? 'DeployedApiTransportError'
      : cause instanceof StartupSnapshotError
        ? 'StartupSnapshotError'
        : cause instanceof Error ? 'Error' : 'UnknownError',
    repository_file:'web/src/testing/productionCapabilityStartup.ts',
    repository_line:sourceLine(marker),
  }
}

async function fail(
  options: SnapshotOptions,
  step: StartupSnapshotStep,
  reasonCode: StartupSnapshotReasonCode,
  result: ApiResult<unknown> | null,
  cause: unknown,
): Promise<never> {
  const detail = diagnostic(step, reasonCode, result, cause)
  await options.onFailureDiagnostic?.(detail)
  throw new StartupSnapshotError(detail)
}

async function readStartupEndpoint(
  options: SnapshotOptions,
  step: StartupSnapshotStep,
  path: string,
): Promise<ApiResult<unknown>> {
  const wait = options.wait ?? (milliseconds => new Promise(
    resolve => setTimeout(resolve, milliseconds),
  ))
  const timeoutMilliseconds = options.requestTimeoutMilliseconds ?? 15_000
  let lastResult: ApiResult<unknown> | null = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await options.api.request<unknown>(
        'GET', path, undefined, { timeoutMilliseconds },
      )
      lastResult = result
      if (result.status === 401) {
        return fail(options, step, 'startup_api_unauthorized', result, null)
      }
      if (result.status === 403) {
        return fail(options, step, 'startup_api_forbidden', result, null)
      }
      if (result.status === 429 || result.status >= 500) {
        if (attempt < 2) {
          await wait(options.retryDelayMilliseconds ?? 200)
          continue
        }
      }
      if (result.status !== 200) {
        return fail(options, step, STEP_FAILURE[step], result, null)
      }
      return result
    } catch (error) {
      if (error instanceof StartupSnapshotError) throw error
      const timedOut = error instanceof DeployedApiTransportError
        || (error instanceof Error && error.message === 'deployed_api_timeout')
      if (timedOut && attempt < 2) {
        await wait(options.retryDelayMilliseconds ?? 200)
        continue
      }
      return fail(
        options, step,
        timedOut ? 'startup_api_timeout' : STEP_FAILURE[step],
        lastResult, error,
      )
    }
  }
  return fail(options, step, STEP_FAILURE[step], lastResult, null)
}

async function validatedRead<T>(
  options: SnapshotOptions,
  step: StartupSnapshotStep,
  path: string,
  parse: (value: unknown) => T | null,
): Promise<T> {
  options.onProgress?.('start', step)
  const result = await readStartupEndpoint(options, step, path)
  const parsed = parse(result.data)
  if (parsed === null) {
    return fail(
      options, step, 'startup_response_shape_invalid', result,
      new Error('startup_response_shape_invalid'),
    )
  }
  options.onProgress?.('complete', step)
  return parsed
}

function stringId(value: unknown): string | null {
  return typeof value === 'string' && UUIDISH_ID.test(value) ? value : null
}

function threadPage(value: unknown): {
  ids: string[]; hasMore: boolean; limit: number; offset: number
} | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null
  if (typeof value.has_more !== 'boolean') return null
  if (!Number.isInteger(value.limit) || !Number.isInteger(value.offset)) return null
  const ids = value.items.map(item => isRecord(item) ? stringId(item.id) : null)
  if (ids.some(id => id === null)) return null
  return {
    ids:ids as string[], hasMore:value.has_more,
    limit:Number(value.limit), offset:Number(value.offset),
  }
}

async function threadIds(
  options: SnapshotOptions,
  step: 'active_threads' | 'archived_threads',
  archived: boolean,
): Promise<string[]> {
  options.onProgress?.('start', step)
  const ids: string[] = []
  for (let offset = 0; offset < 1_000; offset += 100) {
    const result = await readStartupEndpoint(
      options, step,
      `/api/web/threads?archived=${archived}&limit=100&offset=${offset}`,
    )
    const page = threadPage(result.data)
    if (!page || page.offset !== offset || page.limit !== 100) {
      return fail(
        options, step, 'startup_response_shape_invalid', result,
        new Error('startup_response_shape_invalid'),
      )
    }
    ids.push(...page.ids)
    if (!page.hasMore) {
      options.onProgress?.('complete', step)
      return ids
    }
  }
  return fail(
    options, step, STEP_FAILURE[step], null,
    new Error('thread_snapshot_exceeds_bound'),
  )
}

function profile(value: unknown): RestorableProfile | null {
  if (!isRecord(value)) return null
  if (
    typeof value.name !== 'string'
    || !(typeof value.place === 'string' || value.place === null)
    || typeof value.timezone !== 'string'
    || typeof value.assistant_name !== 'string'
    || !['en', 'ta', 'tanglish'].includes(String(value.reply_language))
  ) return null
  return {
    name:value.name,
    place:value.place,
    timezone:value.timezone,
    assistant_name:value.assistant_name,
    reply_language:value.reply_language as 'en' | 'ta' | 'tanglish',
  }
}

function memory(value: unknown): StartupMemorySettings | null {
  if (!isRecord(value)) return null
  if (
    typeof value.available !== 'boolean'
    || typeof value.enabled !== 'boolean'
    || !Array.isArray(value.items)
  ) return null
  const items = value.items.map(item => {
    if (!isRecord(item)) return null
    const id = stringId(item.id)
    return id && typeof item.value_text === 'string'
      ? { id, value_text:item.value_text } : null
  })
  if (items.some(item => item === null)) return null
  if (!value.available && value.enabled) return null
  return {
    available:value.available,
    enabled:value.enabled,
    items:items as StartupMemorySettings['items'],
  }
}

function knowledgeIds(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null
  const ids = value.items.map(item => isRecord(item) ? stringId(item.id) : null)
  return ids.some(id => id === null) ? null : ids as string[]
}

function wallet(value: unknown): { chat: number; voice: number } | null {
  if (!isRecord(value)) return null
  const wallets = isRecord(value.wallets) ? value.wallets : null
  const chat = wallets && isRecord(wallets.chat)
    ? wallets.chat : isRecord(value.wallet) ? value.wallet : value
  const voice = wallets && isRecord(wallets.voice) ? wallets.voice : null
  if (
    !isRecord(chat)
    || typeof chat.available_micros !== 'number'
    || !Number.isSafeInteger(chat.available_micros)
    || !voice
    || typeof voice.available_micros !== 'number'
    || !Number.isSafeInteger(voice.available_micros)
  ) return null
  return { chat:chat.available_micros, voice:voice.available_micros }
}

function latestLedgerId(value: unknown): string | null | undefined {
  if (!isRecord(value) || !Array.isArray(value.items)) return undefined
  if (value.items.length === 0) return null
  const first = value.items[0]
  return isRecord(first) ? stringId(first.id) ?? undefined : undefined
}

export async function snapshotProductionAccountState(
  options: SnapshotOptions,
): Promise<ProductionAccountSnapshot> {
  const activeThreadIds = await threadIds(
    options, 'active_threads', false,
  )
  const archivedThreadIds = await threadIds(
    options, 'archived_threads', true,
  )
  const originalProfile = await validatedRead(
    options, 'profile', '/api/web/settings/profile', profile,
  )
  const originalMemory = await validatedRead(
    options, 'memory', '/api/web/settings/memory', memory,
  )
  let knowledgeDocumentIds: string[] = []
  if (options.knowledgeEnabled) {
    knowledgeDocumentIds = await validatedRead(
      options, 'knowledge', '/api/web/knowledge', knowledgeIds,
    )
  } else {
    options.onProgress?.('start', 'knowledge')
    options.onProgress?.('complete', 'knowledge')
  }
  const originalWallet = await validatedRead(
    options, 'wallet', '/api/web/billing/wallet', wallet,
  )
  const originalLedger = await validatedRead(
    options, 'ledger', '/api/web/billing/ledger?limit=1&offset=0',
    value => {
      const id = latestLedgerId(value)
      return id === undefined ? null : { id }
    },
  )
  options.onProgress?.('complete', 'all')
  return {
    tier:options.tier,
    activeThreadIds,
    archivedThreadIds,
    profile:originalProfile,
    memory:originalMemory,
    knowledgeDocumentIds,
    walletValues:originalWallet,
    latestLedgerId:originalLedger.id,
  }
}
