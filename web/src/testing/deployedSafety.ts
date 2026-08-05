import type { APIRequestContext, Page, Request, Response } from '@playwright/test'

export type ApiResult<T> = {
  status: number
  data: T | null
  contentType?: string | null
  retryAfterSeconds?: number
}

export type DeployedApiRequestOptions = { timeoutMilliseconds?: number }

export interface DeployedApi {
  request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options?: DeployedApiRequestOptions,
  ): Promise<ApiResult<T>>
}

const DEFAULT_DEPLOYED_API_TIMEOUT_MS = 30_000
const MAX_BOUNDED_OPERATION_TIMEOUT_MS = 3 * 60 * 60_000

function boundedRetryAfterSeconds(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,4}$/u.test(value.trim())) return undefined
  const seconds = Number(value.trim())
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 300
    ? seconds : undefined
}

function validatedTimeout(
  value: number | undefined,
  fallback = DEFAULT_DEPLOYED_API_TIMEOUT_MS,
): number {
  const timeout = value ?? fallback
  if (
    !Number.isFinite(timeout)
    || timeout < 1
    || timeout > MAX_BOUNDED_OPERATION_TIMEOUT_MS
  ) throw new Error('bounded_timeout_invalid')
  return Math.floor(timeout)
}

export class DeployedApiTransportError extends Error {
  readonly reasonCode = 'deployed_api_timeout'

  constructor() {
    super('deployed_api_timeout')
    this.name = 'DeployedApiTransportError'
  }
}

export async function withBoundedTimeout<T>(
  operation: () => Promise<T>,
  timeoutMilliseconds: number,
  reasonCode = 'bounded_operation_timeout',
): Promise<T> {
  const timeout = validatedTimeout(timeoutMilliseconds)
  const pending = Promise.resolve().then(operation)
  void pending.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(
          reasonCode === 'deployed_api_timeout'
            ? new DeployedApiTransportError()
            : new Error(reasonCode),
        ), timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const CHAT_STREAM_PATH = '/api/web/chat/stream'

export function isPostChatStreamRequest(request: Request): boolean {
  return new URL(request.url()).pathname === CHAT_STREAM_PATH
    && request.method() === 'POST'
}

export function isPostChatStreamResponse(response: Response): boolean {
  return new URL(response.url()).pathname === CHAT_STREAM_PATH
    && response.request().method() === 'POST'
}

export function observePlaywrightPromise<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined)
  return promise
}

export type CapabilityAssistantRepresentation = {
  lookup: 'dom' | 'api_fallback' | 'unavailable'
  answer: string | null
  reasonCodes: string[]
}

export function resolveCapabilityAssistantRepresentation(options: {
  domObserved: boolean
  domTerminal: boolean
  persistedAnswer: string | null | undefined
}): CapabilityAssistantRepresentation {
  if (options.domObserved && options.domTerminal) {
    return { lookup:'dom', answer:null, reasonCodes:[] }
  }
  const persisted = String(options.persistedAnswer ?? '').trim()
  if (persisted) {
    return {
      lookup:'api_fallback',
      answer:persisted,
      reasonCodes:['ui_render_not_observed'],
    }
  }
  return { lookup:'unavailable', answer:null, reasonCodes:[] }
}

const SAFE_REASON_CODE = /^[a-z][a-z0-9_]{0,79}$/

function boundedReasonCode(reasonCode: string, fallback: string): string {
  return SAFE_REASON_CODE.test(reasonCode) ? reasonCode : fallback
}

export async function runCleanupActionSafely(
  cleanupErrors: string[],
  reasonCode: string,
  action: () => Promise<void>,
  timeoutMilliseconds = DEFAULT_DEPLOYED_API_TIMEOUT_MS,
): Promise<void> {
  try {
    await withBoundedTimeout(
      action, timeoutMilliseconds,
      boundedReasonCode(reasonCode, 'cleanup_action_failed'),
    )
  } catch {
    cleanupErrors.push(boundedReasonCode(reasonCode, 'cleanup_action_failed'))
  }
}

export async function runWithBoundedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  action: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('bounded_concurrency_invalid')
  }
  let next = 0
  const workers = Array.from(
    { length:Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const index = next
        next += 1
        await action(items[index])
      }
    },
  )
  await Promise.all(workers)
}

export async function writeFinalSafetyReports<T>(options: {
  primaryFailure: string | null
  cleanupErrors: string[]
  preliminaryReports: Array<{ reasonCode: string; write: () => Promise<void> }>
  buildSafeSummary: (cleanupErrors: readonly string[]) => T
  writeSafeSummary: (summary: T) => Promise<void>
}): Promise<{
  primaryFailure: string | null
  cleanupErrors: string[]
  safeSummaryWritten: boolean
}> {
  for (const report of options.preliminaryReports) {
    await runCleanupActionSafely(
      options.cleanupErrors,
      boundedReasonCode(report.reasonCode, 'private_report_write_failed'),
      report.write,
    )
  }
  const summary = options.buildSafeSummary(options.cleanupErrors)
  let safeSummaryWritten = true
  try {
    await options.writeSafeSummary(summary)
  } catch {
    safeSummaryWritten = false
    options.cleanupErrors.push('safe_summary_write_failed')
  }
  return {
    primaryFailure:options.primaryFailure,
    cleanupErrors:options.cleanupErrors,
    safeSummaryWritten,
  }
}

export type DeployedMultipartFile = {
  name: string
  mimeType: string
  buffer: Buffer
}

export class AuthenticatedDeployedApi implements DeployedApi {
  constructor(
    private readonly requestContext: APIRequestContext,
    private readonly origin: string,
    private readonly authorization: string,
    private readonly defaultTimeoutMilliseconds = DEFAULT_DEPLOYED_API_TIMEOUT_MS,
  ) {}

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options: DeployedApiRequestOptions = {},
  ): Promise<ApiResult<T>> {
    const timeout = validatedTimeout(
      options.timeoutMilliseconds, this.defaultTimeoutMilliseconds,
    )
    const deadline = Date.now() + timeout
    const response = await withBoundedTimeout(
      () => this.requestContext.fetch(
        `${this.origin}${path}`,
        {
          method,
          timeout,
          headers: {
            Authorization: this.authorization,
            Accept: 'application/json',
          },
          ...(body === undefined ? {} : { data: body }),
        },
      ),
      timeout,
      'deployed_api_timeout',
    )
    const status = response.status()
    const responseHeaders = response.headers()
    const retryAfterSeconds = boundedRetryAfterSeconds(
      responseHeaders['retry-after'],
    )
    const timing = retryAfterSeconds === undefined ? {} : { retryAfterSeconds }
    if (status === 204 || status === 205) {
      return { status, data:null, contentType:null, ...timing }
    }
    const contentType = responseHeaders['content-type'] ?? ''
    if (!contentType.includes('application/json')) {
      return { status, data:null, contentType:contentType || null, ...timing }
    }
    const bodyBytes = await withBoundedTimeout(
      () => response.body(), Math.max(1, deadline - Date.now()),
      'deployed_api_timeout',
    )
    if (bodyBytes.length === 0) return {
      status, data:null, contentType:contentType || null, ...timing,
    }
    try {
      return {
        status,
        data:JSON.parse(bodyBytes.toString('utf8')) as T,
        contentType:contentType || null,
        ...timing,
      }
    } catch {
      // Optional or malformed JSON must not turn an observed HTTP status into
      // a transport failure. Callers still receive and validate non-2xx status.
      return { status, data:null, contentType:contentType || null, ...timing }
    }
  }

  async requestMultipart<T>(
    path: string,
    multipart: Record<string, string | number | boolean | DeployedMultipartFile>,
    options: DeployedApiRequestOptions = {},
  ): Promise<ApiResult<T>> {
    const timeout = validatedTimeout(
      options.timeoutMilliseconds, this.defaultTimeoutMilliseconds,
    )
    const deadline = Date.now() + timeout
    const response = await withBoundedTimeout(
      () => this.requestContext.post(`${this.origin}${path}`, {
        timeout,
        headers: {
          Authorization: this.authorization,
          Accept: 'application/json',
        },
        multipart,
      }),
      timeout,
      'deployed_api_timeout',
    )
    const status = response.status()
    const contentType = response.headers()['content-type'] ?? ''
    if (!contentType.includes('application/json')) {
      return { status, data:null, contentType:contentType || null }
    }
    const body = await withBoundedTimeout(
      () => response.body(), Math.max(1, deadline - Date.now()),
      'deployed_api_timeout',
    )
    if (!body.length) return { status, data:null, contentType:contentType || null }
    try {
      return {
        status,
        data:JSON.parse(body.toString('utf8')) as T,
        contentType:contentType || null,
      }
    } catch {
      return { status, data:null, contentType:contentType || null }
    }
  }
}

export async function waitForDeployedWorkspace(
  page: Page,
  timeoutMilliseconds = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds
  const timeout = () => Math.max(1, deadline - Date.now())
  const composer = page.getByTestId('composer')
  const textbox = page.getByRole('textbox', { name:'Message Swico' })
  await Promise.all([
    composer.waitFor({ state:'visible', timeout:timeout() }),
    textbox.waitFor({ state:'visible', timeout:timeout() }),
  ])
  while (Date.now() < deadline) {
    if (await composer.isEnabled() && await textbox.isEnabled()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error('Authenticated Swico workspace was not ready')
}

export async function loginDeployed<TBootstrap>(
  page: Page,
  email: string,
  password: string,
): Promise<{ api: AuthenticatedDeployedApi; bootstrap: TBootstrap }> {
  if (!email) throw new Error('E2E_TEST_EMAIL must be configured')
  if (!password) throw new Error('E2E_TEST_PASSWORD must be configured')
  await page.goto('/', { waitUntil:'domcontentloaded', timeout:30_000 })
  const bootstrapResponse = observePlaywrightPromise(page.waitForResponse(response => (
    new URL(response.url()).pathname === '/api/web/bootstrap'
    && response.status() === 200
  ), { timeout:60_000 }))
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact:true }).fill(password)
  await page.getByRole('button', { name:'Sign in' }).click()
  const response = await bootstrapResponse
  await waitForDeployedWorkspace(page)
  const authorization = (await response.request().allHeaders()).authorization
  if (!authorization?.startsWith('Bearer ')) {
    throw new Error('Authenticated Swico API request was not observed')
  }
  const bootstrap = await withBoundedTimeout(
    () => response.json() as Promise<TBootstrap>,
    30_000,
    'deployed_api_timeout',
  )
  return {
    api: new AuthenticatedDeployedApi(
      page.request,
      new URL(response.url()).origin,
      authorization,
    ),
    bootstrap,
  }
}

export async function logoutDeployed(
  page: Page, timeoutMilliseconds = 30_000,
): Promise<void> {
  if (page.isClosed()) return
  const deadline = Date.now() + validatedTimeout(timeoutMilliseconds)
  const remaining = () => Math.max(1, deadline - Date.now())
  await page.goto('/', { waitUntil:'domcontentloaded', timeout:remaining() })
  const sidebar = page.getByRole('button', { name:'Open sidebar' })
  if (await sidebar.isVisible()) await sidebar.click({ timeout:remaining() })
  const account = page.locator('.account-button')
  if (!await account.isVisible()) return
  await account.click({ timeout:remaining() })
  await page.getByRole('menuitem', { name:'Sign out' }).click({
    timeout:remaining(),
  })
  await page.getByRole('heading', { name:'Welcome back' }).waitFor({
    state:'visible', timeout:remaining(),
  })
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

export type ThreadCleanupReasonCode =
  | 'thread_delete_http_failure'
  | 'thread_delete_response_parse_failure'
  | 'thread_delete_verification_failure'
  | 'thread_delete_rate_limited'

export class ThreadCleanupError extends Error {
  constructor(readonly reasonCode: ThreadCleanupReasonCode) {
    super(`Generated thread cleanup failed: ${reasonCode}`)
    this.name = 'ThreadCleanupError'
  }
}

const THREAD_DELETE_MAX_ATTEMPTS = 6
const THREAD_DELETE_BACKOFF_MS = [100, 250, 500]
const THREAD_DELETE_DEFAULT_RETRY_AFTER_SECONDS = 60

function threadCleanupFailure(error: unknown): ThreadCleanupError {
  return new ThreadCleanupError(
    error instanceof SyntaxError
      ? 'thread_delete_response_parse_failure'
      : 'thread_delete_http_failure',
  )
}

export async function deleteGeneratedThread(
  api: DeployedApi,
  generatedThreadId: string,
  originalThreadIds: ReadonlySet<string>,
  knownGeneratedThreadIds: ReadonlySet<string> = new Set([generatedThreadId]),
  options: {
    wait?: (milliseconds: number) => Promise<void>
    defaultRetryAfterSeconds?: number
  } = {},
): Promise<void> {
  if (
    originalThreadIds.has(generatedThreadId)
    || !knownGeneratedThreadIds.has(generatedThreadId)
  ) {
    throw new ThreadCleanupError('thread_delete_http_failure')
  }
  const path = `/api/web/threads/${encodeURIComponent(generatedThreadId)}`
  const wait = options.wait ?? (milliseconds => new Promise(
    resolveWait => setTimeout(resolveWait, milliseconds),
  ))
  for (let attempt = 0; attempt < THREAD_DELETE_MAX_ATTEMPTS; attempt += 1) {
    let deleted: ApiResult<never>
    try {
      deleted = await api.request<never>('DELETE', path)
    } catch (error) {
      throw threadCleanupFailure(error)
    }
    if (deleted.status === 204 || deleted.status === 404) break
    if (deleted.status === 429 && attempt < THREAD_DELETE_MAX_ATTEMPTS - 1) {
      const fallback = Math.min(300, Math.max(
        1, Math.floor(
          options.defaultRetryAfterSeconds
          ?? THREAD_DELETE_DEFAULT_RETRY_AFTER_SECONDS,
        ),
      ))
      await wait(1_000 * (deleted.retryAfterSeconds ?? fallback))
      continue
    }
    const transient = deleted.status === 409
      || deleted.status >= 500
    if (!transient || attempt === THREAD_DELETE_MAX_ATTEMPTS - 1) {
      throw new ThreadCleanupError(
        deleted.status === 429
          ? 'thread_delete_rate_limited'
          : 'thread_delete_http_failure',
      )
    }
    await wait(THREAD_DELETE_BACKOFF_MS[Math.min(
      attempt, THREAD_DELETE_BACKOFF_MS.length - 1,
    )])
  }
  let verified: ApiResult<unknown>
  try {
    verified = await api.request<unknown>('GET', path)
  } catch {
    throw new ThreadCleanupError('thread_delete_verification_failure')
  }
  if (verified.status !== 404) {
    throw new ThreadCleanupError('thread_delete_verification_failure')
  }
}

export async function deleteGeneratedKnowledgeDocument(
  api: DeployedApi,
  documentId: string,
  originalDocumentIds: ReadonlySet<string>,
): Promise<void> {
  if (originalDocumentIds.has(documentId)) {
    throw new Error('refusing to delete a pre-existing knowledge document')
  }
  const deleted = await api.request<never>(
    'DELETE', `/api/web/knowledge/${encodeURIComponent(documentId)}`,
  )
  if (deleted.status !== 204) {
    throw new Error('E2E knowledge-document cleanup request failed')
  }
  const verified = await api.request<unknown>(
    'GET', `/api/web/knowledge/${encodeURIComponent(documentId)}`,
  )
  if (verified.status !== 404) {
    throw new Error('E2E knowledge-document cleanup verification failed')
  }
}

export async function deleteGeneratedRepository(
  api: DeployedApi,
  repositoryId: string,
): Promise<void> {
  const deleted = await api.request<never>(
    'DELETE', `/api/web/repositories/${encodeURIComponent(repositoryId)}`,
  )
  if (deleted.status !== 204) {
    throw new Error('E2E repository cleanup request failed')
  }
}

export async function deleteGeneratedUpload(
  api: DeployedApi,
  uploadId: string,
): Promise<void> {
  const deleted = await api.request<never>(
    'DELETE', `/api/web/uploads/${encodeURIComponent(uploadId)}`,
  )
  if (deleted.status !== 204) {
    throw new Error('E2E temporary-upload cleanup request failed')
  }
}
