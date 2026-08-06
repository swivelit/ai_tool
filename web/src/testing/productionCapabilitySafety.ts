import { randomUUID } from 'node:crypto'

export const PRODUCTION_CAPABILITY_CONFIRMATION =
  'I_UNDERSTAND_THIS_RUNS_BILLABLE_PRODUCTION_CAPABILITY_TESTS'

export const PRODUCTION_CAPABILITY_BATCHES = [
  'core', 'context', 'rag', 'repository', 'voice-ui', 'routing', 'all', 'full',
] as const

export type ProductionCapabilityBatch =
  typeof PRODUCTION_CAPABILITY_BATCHES[number]

export const PRODUCTION_CAPABILITY_CORE_TIMEOUT_MS = 45 * 60_000
export const PRODUCTION_CAPABILITY_ALL_TIMEOUT_MS = 180 * 60_000

export function capabilityEffectiveTimeoutMs(
  batch: ProductionCapabilityBatch,
): number {
  return batch === 'core'
    ? PRODUCTION_CAPABILITY_CORE_TIMEOUT_MS
    : PRODUCTION_CAPABILITY_ALL_TIMEOUT_MS
}

export function capabilityCleanupDeadlineMs(generatedThreadCount: number): number {
  const count = Number.isFinite(generatedThreadCount)
    ? Math.max(0, Math.floor(generatedThreadCount)) : 0
  const mutationWindows = count > 0 ? Math.ceil(count / 30) : 0
  return Math.min(
    15 * 60_000,
    5 * 60_000 + count * 4_000 + mutationWindows * 60_000,
  )
}

export function assertUniqueCapabilityScenarioIds(
  scenarioIds: readonly string[],
): void {
  const seen = new Set<string>()
  for (const scenarioId of scenarioIds) {
    if (seen.has(scenarioId)) throw new Error('duplicate_scenario_id')
    seen.add(scenarioId)
  }
}

export function remainingCapabilitySseBodyTimeoutMs(
  questionDeadlineMilliseconds: number,
  nowMilliseconds: number,
): number {
  // Playwright can surface the terminal UI/audit before its streaming body
  // promise finishes draining. Keep the ordinary six-minute question bound,
  // but allow a small bounded terminal-drain grace instead of turning a
  // completed short answer into response_body_timeout at the deadline edge.
  return Math.min(
    6 * 60_000,
    Math.max(90_000, questionDeadlineMilliseconds - nowMilliseconds),
  )
}

export function capabilitySafeFailureReason(input: {
  startupFailureReason: string | null
  deploymentParityFailureReason: string | null
  acceptanceFailed: boolean
}): string | null {
  return input.startupFailureReason
    ?? input.deploymentParityFailureReason
    ?? (input.acceptanceFailed ? 'capability_acceptance_failed' : null)
}

export type CapabilityAnswerRepresentationCounts = {
  visibleBulletCount: number
  rawBulletCount: number
  visibleFenceCount: number
  rawFenceCount: number
  visibleWordCount: number
  rawWordCount: number
}

export function capabilityAnswerRepresentationCounts(
  visibleText: string,
  rawMarkdown: string,
): CapabilityAnswerRepresentationCounts {
  return {
    visibleBulletCount:bulletLines(visibleText).length,
    rawBulletCount:bulletLines(rawMarkdown).length,
    visibleFenceCount:(visibleText.match(/```/gu) ?? []).length / 2,
    rawFenceCount:(rawMarkdown.match(/```/gu) ?? []).length / 2,
    visibleWordCount:countWords(visibleText),
    rawWordCount:countMarkdownWords(rawMarkdown),
  }
}

export type CapabilityProgressKind =
  | 'parity_passed'
  | 'login_passed'
  | 'startup_snapshot_start'
  | 'startup_snapshot_complete'
  | 'question_start'
  | 'question_complete'
  | 'workflow_start'
  | 'workflow_complete'
  | 'cleanup_start'
  | 'cleanup_complete'
  | 'safe_summary_write_start'
  | 'safe_summary_write_complete'
  | 'heartbeat'

const SAFE_PROGRESS_VALUE = /^[A-Za-z0-9_-]{1,80}$/
const SAFE_PROGRESS_REQUEST_ID = /^[0-9a-f-]{36}$/i

export function formatCapabilityProgress(input: {
  kind: CapabilityProgressKind
  phase: string
  scenarioId?: string | null
  elapsedSeconds: number
  requestId?: string | null
}): string {
  const phase = SAFE_PROGRESS_VALUE.test(input.phase) ? input.phase : 'unknown'
  const scenario = input.scenarioId
    && SAFE_PROGRESS_VALUE.test(input.scenarioId)
    ? input.scenarioId : 'none'
  const elapsed = Number.isFinite(input.elapsedSeconds)
    ? Math.max(0, Math.min(10_800, Math.floor(input.elapsedSeconds))) : 0
  const requestId = input.requestId
    && SAFE_PROGRESS_REQUEST_ID.test(input.requestId)
    ? input.requestId : null
  return [
    '[capability]', input.kind,
    `phase=${phase}`, `scenario=${scenario}`, `elapsed_seconds=${elapsed}`,
    ...(requestId ? [`request_id=${requestId}`] : []),
  ].join(' ')
}

export type CapabilityEnvironment = {
  GITHUB_SHA?: string
  PLAYWRIGHT_BASE_URL?: string
  PLAYWRIGHT_API_BASE_URL?: string
  E2E_TEST_EMAIL?: string
  E2E_TEST_PASSWORD?: string
  PRODUCTION_CAPABILITY_CONFIRMATION?: string
  PRODUCTION_CAPABILITY_MAX_CHAT_DEBIT_MICROS?: string
  PRODUCTION_CAPABILITY_MAX_VOICE_DEBIT_MICROS?: string
  PRODUCTION_CAPABILITY_BATCH?: string
}

const DEPLOYMENT_SHA_PATTERN = /^[0-9a-f]{7,40}$/

export type DeploymentParityStatus =
  | 'matched'
  | 'backend_release_unavailable'
  | 'backend_release_mismatch'

export type DeploymentReleaseObservation = {
  release: unknown
  httpStatus: number | null
}

export type DeploymentParityResult = {
  expectedCommitSha: string | null
  observedBackendRelease: string | null
  status: DeploymentParityStatus
  checks: number
  elapsedWaitMs: number
  backendEndpointHostname: string
  lastHttpStatus: number | null
  safeFailureReason: Exclude<DeploymentParityStatus, 'matched'> | null
}

export type DeploymentParitySafeSummary = {
  expected_commit_sha: string | null
  observed_backend_release: string | null
  deployment_parity_status: DeploymentParityStatus
  deployment_parity_checks: number
  deployment_parity_elapsed_wait_ms: number
  backend_endpoint_hostname: string
  last_http_status: number | null
  safe_failure_reason: Exclude<DeploymentParityStatus, 'matched'> | null
}

export class DeploymentParityError extends Error {
  readonly reasonCode: Exclude<DeploymentParityStatus, 'matched'>

  constructor(readonly result: DeploymentParityResult) {
    const unavailable = result.status === 'backend_release_unavailable'
    super(unavailable
      ? 'backend_release_unavailable: verify PLAYWRIGHT_API_BASE_URL and '
        + 'public /api/version availability, then rerun'
      : 'backend_release_mismatch: deploy the latest commit to the ai_tool '
        + 'Render service, verify that the Render branch is main, and rerun '
        + 'after the backend release matches')
    this.name = 'DeploymentParityError'
    this.reasonCode = unavailable
      ? 'backend_release_unavailable' : 'backend_release_mismatch'
  }
}

export type CapabilityApiBase = {
  baseUrl: string
  hostname: string
}

export function normalizeCapabilityApiBaseUrl(
  value: unknown,
): CapabilityApiBase | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const trimmed = value.trim()
    if (/[?#]/u.test(trimmed)) return null
    const parsed = new URL(trimmed)
    if (
      parsed.protocol !== 'https:'
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null
    const pathname = parsed.pathname.replace(/\/+$/u, '')
    return {
      baseUrl:`${parsed.origin}${pathname === '/' ? '' : pathname}`,
      hostname:parsed.hostname.toLowerCase(),
    }
  } catch {
    return null
  }
}

export function deploymentVersionUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl}/api/version`
}

export function normalizeDeploymentSha(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return DEPLOYMENT_SHA_PATTERN.test(normalized) ? normalized : null
}

export function releaseShaFromVersionPayload(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  const candidate = Object.prototype.hasOwnProperty.call(
    payload, 'backend_release_sha',
  )
    ? payload.backend_release_sha
    // Compatibility with older public /api/version responses only.
    : payload.app_release
  return normalizeDeploymentSha(candidate)
}

export function deploymentShasMatch(
  expectedCommitSha: unknown,
  observedBackendRelease: unknown,
): boolean {
  const expected = normalizeDeploymentSha(expectedCommitSha)
  const observed = normalizeDeploymentSha(observedBackendRelease)
  if (!expected || !observed) return false
  return expected.startsWith(observed) || observed.startsWith(expected)
}

export async function pollDeploymentParity(options: {
  expectedCommitSha: unknown
  backendEndpointHostname: string
  readBackendRelease: (
    timeoutMs: number,
  ) => Promise<DeploymentReleaseObservation>
  intervalMs?: number
  maxWaitMs?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}): Promise<DeploymentParityResult> {
  const intervalMs = options.intervalMs ?? 20_000
  const maxWaitMs = options.maxWaitMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  const wait = options.wait ?? (
    milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  )
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('deployment_parity_interval_invalid')
  }
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
    throw new Error('deployment_parity_max_wait_invalid')
  }
  const expected = normalizeDeploymentSha(options.expectedCommitSha)
  if (!expected) {
    return {
      expectedCommitSha:null, observedBackendRelease:null,
      status:'backend_release_mismatch', checks:0, elapsedWaitMs:0,
      backendEndpointHostname:options.backendEndpointHostname,
      lastHttpStatus:null, safeFailureReason:'backend_release_mismatch',
    }
  }
  const startedAt = now()
  let checks = 0
  let lastValidRelease: string | null = null
  let lastHttpStatus: number | null = null
  const failedResult = (elapsedWaitMs: number): DeploymentParityResult => {
    const status = lastValidRelease
      ? 'backend_release_mismatch' : 'backend_release_unavailable'
    return {
      expectedCommitSha:expected,
      observedBackendRelease:lastValidRelease,
      status,
      checks,
      elapsedWaitMs,
      backendEndpointHostname:options.backendEndpointHostname,
      lastHttpStatus,
      safeFailureReason:status,
    }
  }
  while (true) {
    const elapsedBeforeCheck = Math.max(0, now() - startedAt)
    if (checks > 0 && elapsedBeforeCheck >= maxWaitMs) {
      return failedResult(elapsedBeforeCheck)
    }
    checks += 1
    try {
      const remainingMs = Math.max(1, maxWaitMs - elapsedBeforeCheck)
      const observation = await options.readBackendRelease(
        Math.min(30_000, remainingMs),
      )
      const observedHttpStatus = Number.isInteger(observation.httpStatus)
        && Number(observation.httpStatus) >= 100
        && Number(observation.httpStatus) <= 599
        ? Number(observation.httpStatus) : null
      if (observedHttpStatus !== null) lastHttpStatus = observedHttpStatus
      const observed = normalizeDeploymentSha(observation.release)
      if (observed) lastValidRelease = observed
    } catch {
      // A transport failure contributes an unavailable observation.
    }
    const elapsedWaitMs = Math.max(0, now() - startedAt)
    if (deploymentShasMatch(expected, lastValidRelease)) {
      return {
        expectedCommitSha:expected, observedBackendRelease:lastValidRelease,
        status:'matched', checks, elapsedWaitMs,
        backendEndpointHostname:options.backendEndpointHostname,
        lastHttpStatus, safeFailureReason:null,
      }
    }
    if (elapsedWaitMs >= maxWaitMs) {
      return failedResult(elapsedWaitMs)
    }
    await wait(Math.min(intervalMs, maxWaitMs - elapsedWaitMs))
  }
}

export function deploymentParitySafeSummary(
  result: DeploymentParityResult,
): DeploymentParitySafeSummary {
  return {
    expected_commit_sha:result.expectedCommitSha,
    observed_backend_release:result.observedBackendRelease,
    deployment_parity_status:result.status,
    deployment_parity_checks:result.checks,
    deployment_parity_elapsed_wait_ms:result.elapsedWaitMs,
    backend_endpoint_hostname:result.backendEndpointHostname,
    last_http_status:result.lastHttpStatus,
    safe_failure_reason:result.safeFailureReason,
  }
}

export async function enforceProductionDeploymentParity(options: {
  expectedCommitSha: unknown
  backendEndpointHostname: string
  readBackendRelease: (
    timeoutMs: number,
  ) => Promise<DeploymentReleaseObservation>
  writeSafeFailure: (summary: DeploymentParitySafeSummary) => Promise<void>
  intervalMs?: number
  maxWaitMs?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}): Promise<DeploymentParityResult> {
  const result = await pollDeploymentParity(options)
  if (result.status === 'matched') return result
  await options.writeSafeFailure(deploymentParitySafeSummary(result))
  throw new DeploymentParityError(result)
}

export type CapabilityGate = {
  batch: ProductionCapabilityBatch
  chatDebitCapMicros: number
  voiceDebitCapMicros: number
  apiBaseUrl: string
  apiHostname: string
}

export class ProductionCapabilityGateError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Production capability gate failed: ${reasonCode}`)
    this.name = 'ProductionCapabilityGateError'
  }
}

function positiveInteger(raw: string | undefined, reasonCode: string): number {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
    throw new ProductionCapabilityGateError(reasonCode)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new ProductionCapabilityGateError(reasonCode)
  }
  return value
}

export function productionCapabilityGate(
  env: CapabilityEnvironment,
): CapabilityGate {
  for (const name of [
    'PLAYWRIGHT_BASE_URL', 'E2E_TEST_EMAIL', 'E2E_TEST_PASSWORD',
  ] as const) {
    if (!env[name]?.trim()) {
      throw new ProductionCapabilityGateError(
        `${name.toLowerCase()}_missing`,
      )
    }
  }
  if (!env.PLAYWRIGHT_API_BASE_URL?.trim()) {
    throw new ProductionCapabilityGateError(
      'playwright_api_base_url_missing',
    )
  }
  const apiBase = normalizeCapabilityApiBaseUrl(
    env.PLAYWRIGHT_API_BASE_URL,
  )
  if (!apiBase) {
    throw new ProductionCapabilityGateError(
      'playwright_api_base_url_invalid',
    )
  }
  if (
    env.PRODUCTION_CAPABILITY_CONFIRMATION
    !== PRODUCTION_CAPABILITY_CONFIRMATION
  ) {
    throw new ProductionCapabilityGateError(
      'production_capability_confirmation_invalid',
    )
  }
  const batch = env.PRODUCTION_CAPABILITY_BATCH ?? 'all'
  if (!PRODUCTION_CAPABILITY_BATCHES.includes(
    batch as ProductionCapabilityBatch,
  )) {
    throw new ProductionCapabilityGateError(
      'production_capability_batch_invalid',
    )
  }
  return {
    batch:batch as ProductionCapabilityBatch,
    apiBaseUrl:apiBase.baseUrl,
    apiHostname:apiBase.hostname,
    chatDebitCapMicros:positiveInteger(
      env.PRODUCTION_CAPABILITY_MAX_CHAT_DEBIT_MICROS,
      'production_capability_chat_debit_cap_invalid',
    ),
    voiceDebitCapMicros:positiveInteger(
      env.PRODUCTION_CAPABILITY_MAX_VOICE_DEBIT_MICROS,
      'production_capability_voice_debit_cap_invalid',
    ),
  }
}

export function batchIncludes(
  selected: ProductionCapabilityBatch,
  scenarioBatch: Exclude<ProductionCapabilityBatch, 'all' | 'full'>,
): boolean {
  return selected === 'all' || selected === 'full' || selected === scenarioBatch
}

export class DebitCapExceeded extends Error {
  constructor(readonly bucket: 'chat' | 'voice') {
    super(`Production capability ${bucket} debit cap reached`)
    this.name = 'DebitCapExceeded'
  }
}

export class DebitBudget {
  private chatCharged = 0
  private voiceCharged = 0

  constructor(
    readonly chatCapMicros: number,
    readonly voiceCapMicros: number,
  ) {}

  assertRequestMayStart(bucket: 'chat' | 'voice'): void {
    const charged = bucket === 'chat' ? this.chatCharged : this.voiceCharged
    const cap = bucket === 'chat'
      ? this.chatCapMicros : this.voiceCapMicros
    if (charged >= cap) throw new DebitCapExceeded(bucket)
  }

  observeAuthoritativeCharge(
    bucket: 'chat' | 'voice',
    chargedMicros: number,
  ): void {
    if (!Number.isSafeInteger(chargedMicros) || chargedMicros < 0) {
      throw new Error('Invalid authoritative production charge')
    }
    if (bucket === 'chat') this.chatCharged += chargedMicros
    else this.voiceCharged += chargedMicros
  }

  snapshot(): { chat: number; voice: number } {
    return { chat:this.chatCharged, voice:this.voiceCharged }
  }
}

const SECRET_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code:'private_key', pattern:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { code:'jwt', pattern:/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { code:'provider_secret_key', pattern:/\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { code:'google_key', pattern:/\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { code:'aws_key', pattern:/\bAKIA[0-9A-Z]{16}\b/ },
  { code:'database_url', pattern:/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/i },
  { code:'bearer', pattern:/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i },
  { code:'secret_assignment', pattern:/\b(?:API_KEY|AUTH_TOKEN|SECRET_KEY|PASSWORD)\s*[=:]\s*[^\s,;]{8,}/i },
]

export type RedactionResult = {
  text: string
  potentialSecret: boolean
  reasonCodes: string[]
}

export function redactPotentialSecrets(input: string): RedactionResult {
  let text = String(input ?? '')
  const reasonCodes: string[] = []
  for (const item of SECRET_PATTERNS) {
    if (!item.pattern.test(text)) continue
    reasonCodes.push(item.code)
    text = text.replace(
      new RegExp(item.pattern.source, item.pattern.flags.includes('g')
        ? item.pattern.flags : `${item.pattern.flags}g`),
      '[REDACTED POTENTIAL SECRET]',
    )
  }
  return {
    text,
    potentialSecret:reasonCodes.length > 0,
    reasonCodes:[...new Set(reasonCodes)],
  }
}

export function countWords(value: string): number {
  return String(value).trim().match(/\S+/gu)?.length ?? 0
}

export function countMarkdownWords(value: string): number {
  const semanticLines = String(value).split(/\r?\n/u).flatMap(line => {
    if (/^\s*```[A-Za-z0-9_+.-]*\s*$/u.test(line)) return []
    return [line.replace(/^\s*(?:[-*+] |\d+[.)]\s+)/u, '')]
  })
  return countWords(semanticLines.join('\n'))
}

export { sharedSentenceCount as countSentences } from './sentenceSegmentation'

export function bulletLines(value: string): string[] {
  return String(value).split(/\r?\n/).filter(line => (
    /^\s*(?:[-*+] |\d+[.)] )/.test(line)
  ))
}

export function hasAffirmativeWaitAdvice(value: string): boolean {
  const text = String(value)
  for (const match of text.matchAll(/\bwait\s+(?:for|until)\b/giu)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index)
    if (/\b(?:do not|don't|never|must not|should not|cannot|can't)\s*$/iu.test(prefix)) {
      continue
    }
    return true
  }
  return false
}

const REPOSITORY_PATH = /(?<![A-Za-z0-9:/])((?:(?:\.{1,2}\/)?[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,16})(?=$|[\s`'"),.:;\]])/giu
const REPOSITORY_UNCERTAINTY_VERB = '(?:verify|determine|confirm|find|identify|describe|assess|say|tell|list|answer|establish)'
const REPOSITORY_UNCERTAINTY = new RegExp(
  `\\b(?:can(?:not|'t|’t)\\s+(?:(?:honestly|reliably|confidently|accurately)\\s+)?${REPOSITORY_UNCERTAINTY_VERB}`
  + `|unable\\s+to\\s+(?:(?:honestly|reliably|confidently|accurately)\\s+)?${REPOSITORY_UNCERTAINTY_VERB}`
  + `|don(?:'t|’t)\\s+have|no\\s+access|not\\s+available`
  + `|not\\s+(?:provided|stated|found|present)|doesn(?:'t|’t)\\s+exist`
  + `|does\\s+not\\s+(?:exist|contain|provide)|no\\s+such\\s+file`
  + `|no\\s+(?:repository\\s+)?(?:entry|record|match)`
  + `|couldn(?:'t|’t)\\s+find\\s+enough\\s+support|insufficient)\\b`,
  'iu',
)
const REPOSITORY_GENERIC_INABILITY = /\b(?:can(?:not|'t|’t)|unable\s+to|won(?:'t|’t)|will\s+not|do(?:n(?:'t|’t)|\s+not)|no\s+way\s+to|without)\b/iu
const REPOSITORY_AFFIRMATIVE_CLAIM = /\b(?:exists?|is\s+present|logic\s+lives|defines?|implements?|exports?|imports?|contains?|handles?|returns?|used\s+by|imported\s+by)\b/giu
const REPOSITORY_DIRECT_NEGATION = /\b(?:does\s+not|doesn(?:'t|’t)|is\s+not|isn(?:'t|’t)|not|never|cannot|can(?:'t|’t)|unable\s+to)\s+(?:(?:actually|currently|necessarily|appear(?:s)?\s+to)\s+)?$/iu

function hasRepositoryAffirmativeClaim(sentence: string): boolean {
  for (const match of sentence.matchAll(REPOSITORY_AFFIRMATIVE_CLAIM)) {
    const prefix = sentence.slice(0, match.index ?? 0)
    if (REPOSITORY_GENERIC_INABILITY.test(prefix)) continue
    if (REPOSITORY_UNCERTAINTY.test(prefix)) continue
    if (REPOSITORY_DIRECT_NEGATION.test(prefix.slice(-100))) continue
    return true
  }
  return false
}

export type RepositoryAbsenceEvaluation = {
  passed: boolean
  inabilityPresent: boolean
  affirmativeClaimPresent: boolean
  citedPathCount: number
}

export function evaluateRepositoryAbsenceAnswer(
  answer: string,
  userMessage: string,
): RepositoryAbsenceEvaluation {
  const value = String(answer ?? '')
  const prompt = String(userMessage ?? '').replaceAll('\\', '/').toLocaleLowerCase()
  const sentences = value.split(/(?<=[.!?])\s+|\n+/u)
  let inabilityPresent = REPOSITORY_UNCERTAINTY.test(value)
  let affirmativeClaimPresent = false
  const cited = new Set<string>()
  for (const sentence of sentences) {
    const uncertain = REPOSITORY_UNCERTAINTY.test(sentence)
      || REPOSITORY_GENERIC_INABILITY.test(sentence)
    if (hasRepositoryAffirmativeClaim(sentence) && !uncertain) {
      affirmativeClaimPresent = true
    }
    for (const match of sentence.matchAll(REPOSITORY_PATH)) {
      const path = String(match[1] ?? '').replace(/^\.\//u, '')
      const echoed = prompt.includes(path.toLocaleLowerCase())
      if (!echoed && !uncertain) cited.add(path)
    }
  }
  inabilityPresent ||= cited.size === 0 && REPOSITORY_UNCERTAINTY.test(value)
  return {
    passed:!affirmativeClaimPresent && (inabilityPresent || cited.size === 0),
    inabilityPresent,
    affirmativeClaimPresent,
    citedPathCount:cited.size,
  }
}

export function hasInsufficientEvidenceLanguage(value: string): boolean {
  return REPOSITORY_UNCERTAINTY.test(String(value ?? ''))
}

export function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]
}

export function newCapabilityRunId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `SWICO-CAP-${timestamp}-${randomUUID().slice(0, 8)}`
}

export type ScoreDimensions = {
  correctness: number
  format: number
  completeness: number
  grounding: number
  safety: number
  efficiency: number
  reliability: number
}

export const SCORE_WEIGHTS: ScoreDimensions = {
  correctness:35,
  format:15,
  completeness:15,
  grounding:15,
  safety:10,
  efficiency:5,
  reliability:5,
}

export function weightedScore(
  fractions: Partial<ScoreDimensions>,
  applicable: Array<keyof ScoreDimensions>,
): { score: number; redistributedWeights: Partial<ScoreDimensions> } {
  if (!applicable.length) throw new Error('At least one score dimension applies')
  const original = applicable.reduce(
    (sum, dimension) => sum + SCORE_WEIGHTS[dimension], 0,
  )
  const weights: Partial<ScoreDimensions> = {}
  let score = 0
  for (const dimension of applicable) {
    const weight = SCORE_WEIGHTS[dimension] * 100 / original
    weights[dimension] = weight
    const fraction = Math.max(0, Math.min(1, fractions[dimension] ?? 0))
    score += weight * fraction
  }
  return {
    score:Number(score.toFixed(2)),
    redistributedWeights:weights,
  }
}

export function parseSseEventOrder(raw: string): string[] {
  const events: string[] = []
  for (const block of String(raw).split(/\r?\n\r?\n/)) {
    const match = block.match(/^event:\s*([^\r\n]+)/m)
    if (match) events.push(match[1].trim().slice(0, 40))
  }
  return events
}

export function sourceIdsFromVisibleText(value: string): string[] {
  return [...String(value).matchAll(/\bS\d{1,3}\b/g)].map(match => match[0])
}

export const WEBHOOK_ARCHITECTURE_AREAS = [
  'database_schema', 'transaction_boundaries', 'state_transitions',
  'pseudocode', 'duplicate_handling', 'out_of_order_handling',
  'failure_recovery', 'reconciliation', 'security_checks', 'test_plan',
] as const

export const CAPABILITY_SEMANTIC_VALIDATOR_VERSION = '2026-08-03.6'

export type IdempotencySemanticEvaluation = {
  definitionPresent: boolean
  concreteRetryExamplePresent: boolean
  stableOutcomePresent: boolean
  validatorVersion: string
}

export type IdempotencySemanticFailureReason =
  | 'semantic_definition_missing'
  | 'semantic_retry_example_missing'
  | 'semantic_stable_outcome_missing'

export function idempotencySemanticFailureReasons(
  evaluation: IdempotencySemanticEvaluation,
  options: { requireStableOutcome: boolean },
): IdempotencySemanticFailureReason[] {
  const reasons: IdempotencySemanticFailureReason[] = []
  if (!evaluation.definitionPresent) reasons.push('semantic_definition_missing')
  if (!evaluation.concreteRetryExamplePresent) {
    reasons.push('semantic_retry_example_missing')
  }
  if (options.requireStableOutcome && !evaluation.stableOutcomePresent) {
    reasons.push('semantic_stable_outcome_missing')
  }
  return reasons
}

export function idempotencySemanticContractPassed(
  answer: string,
  options: { requireStableOutcome: boolean },
): boolean {
  return idempotencySemanticFailureReasons(
    evaluateIdempotencySemantics(answer), options,
  ).length === 0
}

export function evaluateIdempotencySemantics(
  answer: string,
): IdempotencySemanticEvaluation {
  const value = String(answer)
  const definitionPresent = /\bidempoten\w*\b/i.test(value)
    && /\b(?:payment|charge|request|operation|endpoint|API)\w*\b/i.test(value)
    && /\b(?:means|is|refers to|ensures|allows|prevents|guarantees|describes|when)\b/i.test(value)
  const retryPresent = /\b(?:retry|retries|retried|repeated request|request again|sends? (?:it|the request) again|second attempt)\b/i.test(value)
  const concreteMarker = /\b(?:GET|POST|PUT|PATCH|DELETE)\b|\/[A-Za-z][A-Za-z0-9_/-]*|\b(?:after (?:a )?timeout|client|identifier|request id|payment id|order id|idempotency key)\b/i.test(value)
  const stableOutcomePresent = /\b(?:reuse[sd]? (?:the |an? )?(?:same )?(?:identifier|key|id)|same (?:identifier|key|id|result|response|outcome)|(?:return|receive[sd]?|gets?) (?:the )?(?:stored|previous|original|same|first) (?:result|response|outcome)|(?:without|no|prevent(?:s|ing)?|avoid(?:s|ing)?) (?:a |the )?(?:second|additional|duplicate) (?:charge|payment|processing|operation)|(?:one|single) (?:charge|payment|operation|result|outcome)|already processed|does not (?:charge|process|create) (?:it )?again|instead of duplicate processing|prevents? duplicate (?:work|processing|charges?|payments?))\b/i.test(value)
  return {
    definitionPresent,
    concreteRetryExamplePresent:retryPresent && concreteMarker,
    stableOutcomePresent,
    validatorVersion:CAPABILITY_SEMANTIC_VALIDATOR_VERSION,
  }
}

export type WebhookArchitectureEvaluation = {
  postgresAuthoritative: boolean
  redisValkeyForbiddenAuthorityPassed: boolean
  nonPostgresAuthoritativeClaim: boolean
  coveredAreas: typeof WEBHOOK_ARCHITECTURE_AREAS[number][]
  missingAreas: typeof WEBHOOK_ARCHITECTURE_AREAS[number][]
  areaEvaluations: ArchitectureAreaEvaluation[]
  validatorVersion: string
}

export type ArchitectureAreaEvaluation = {
  areaIdentifier: typeof WEBHOOK_ARCHITECTURE_AREAS[number]
  headingPresent: boolean
  semanticMechanismPresent: boolean
  stableSideEffectOutcomePresent: boolean
  passed: boolean
}

function hasAll(value: string, patterns: RegExp[]): boolean {
  return patterns.every(pattern => pattern.test(value))
}

export function normalizeArchitectureSemantics(answer: string): string {
  return String(answer)
    .toLowerCase()
    .replace(/^\s{0,3}#{1,6}\s*/gmu, '')
    .replace(/\*\*|__|`/gu, ' ')
    .replace(/[-\u2010-\u2015\u2212_]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function architectureAreaFromLabel(
  label: string,
): typeof WEBHOOK_ARCHITECTURE_AREAS[number] | null {
  const value = normalizeArchitectureSemantics(label)
  const rules: Array<[
    typeof WEBHOOK_ARCHITECTURE_AREAS[number], RegExp[],
  ]> = [
    ['database_schema', [/\bdatabase\b.*\b(?:table|schema)/u, /\b(?:tables?|schema)\b.*\b(?:unique|constraint)/u]],
    ['transaction_boundaries', [/\btransaction\b.*\bboundar/u]],
    ['state_transitions', [/\b(?:event|payment|state)\b.*\btransition/u]],
    ['pseudocode', [/\bpseudocode\b/u]],
    ['duplicate_handling', [/\bduplicate\b.*\bhandling\b/u]],
    ['out_of_order_handling', [/\bout of order\b.*\bhandling\b/u]],
    ['failure_recovery', [/\bfailure\b.*\brecovery\b/u]],
    ['reconciliation', [/\breconcil/u]],
    ['security_checks', [/\bsecurity\b.*\bchecks?\b/u]],
    ['test_plan', [/\btest\b.*\bplan\b/u]],
  ]
  return rules.find(([, patterns]) => patterns.some(pattern => pattern.test(value)))?.[0] ?? null
}

type ArchitectureSection = { normalizedValue: string; rawValue: string }

function architectureSections(answer: string): {
  sections: Map<typeof WEBHOOK_ARCHITECTURE_AREAS[number], ArchitectureSection>
  normalizedFallback: string
  rawFallback: string
} {
  const value = String(answer)
  const fencedRanges = [...value.matchAll(/```[\s\S]*?```/gu)].map(match => ({
    start:match.index ?? 0,
    end:(match.index ?? 0) + match[0].length,
  }))
  const candidates = [...value.matchAll(
    /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*)?(\d{1,2})[.)]\s+(?:\*\*)?(.+?)(?:\*\*)?\s*$/gmu,
  )].filter(match => !fencedRanges.some(range => (
    range.start <= (match.index ?? 0) && (match.index ?? 0) < range.end
  )))
  const accepted: Array<{
    areaIdentifier: typeof WEBHOOK_ARCHITECTURE_AREAS[number]
    match: RegExpMatchArray
  }> = []
  let lastOrdinal = 0
  for (const match of candidates) {
    const ordinal = Number(match[1])
    if (ordinal <= lastOrdinal || ordinal > WEBHOOK_ARCHITECTURE_AREAS.length) {
      continue
    }
    const area = architectureAreaFromLabel(match[2] ?? '')
    const expectedArea = WEBHOOK_ARCHITECTURE_AREAS[ordinal - 1]
    if (area !== expectedArea) continue
    accepted.push({ areaIdentifier:expectedArea, match })
    lastOrdinal = ordinal
  }
  const sections = new Map<
    typeof WEBHOOK_ARCHITECTURE_AREAS[number], ArchitectureSection
  >()
  for (let index = 0; index < accepted.length; index += 1) {
    const { areaIdentifier, match } = accepted[index]
    const start = (match.index ?? 0) + match[0].length
    const end = accepted[index + 1]?.match.index ?? value.length
    const labelParts = (match[2] ?? '').split(
      /\s+(?:[-\u2010-\u2015\u2212]|:)\s+/u,
      2,
    )
    const inlineDetail = labelParts.length === 2 ? labelParts[1] : ''
    const rawValue = `${inlineDetail}\n${value.slice(start, end)}`
    sections.set(areaIdentifier, {
      normalizedValue:normalizeArchitectureSemantics(rawValue),
      rawValue,
    })
  }
  const fallbackParts: string[] = []
  let cursor = 0
  for (const { match } of accepted) {
    fallbackParts.push(value.slice(cursor, match.index ?? 0), '\n')
    cursor = (match.index ?? 0) + match[0].length
  }
  fallbackParts.push(value.slice(cursor))
  const rawFallback = fallbackParts.join('')
  return {
    sections,
    normalizedFallback:normalizeArchitectureSemantics(rawFallback),
    rawFallback,
  }
}

function duplicateArchitectureSemantics(value: string): {
  mechanism: boolean
  stableOutcome: boolean
} {
  const mechanism = /\b(?:deduplicat\w*|dedupe\w*|idempotent|idempotency|already processed|unique provider event id|unique event(?: id)? constraint|on conflict|(?:ignore|ignored|acknowledge|acknowledged) (?:a )?duplicate|stored event result)\b/u.test(value)
  const stableOutcome = /\bon conflict do nothing\b|\b(?:return|returns|acknowledge|acknowledges) (?:http )?(?:200|success)[^.;]{0,70}\b(?:already processed|duplicate)\b|\b(?:already processed|duplicate)\b[^.;]{0,70}\b(?:return|returns|acknowledge|acknowledges) (?:http )?(?:200|success)\b|\b(?:no|without|prevent\w*|cannot|does not)\b[^.;]{0,70}\b(?:second|another|repeated|duplicate)\b[^.;]{0,35}\b(?:wallet credit|ledger credit|ledger mutation|charge|processing|side effect)\b|\breuse\w* (?:the )?stored event result\b/u.test(value)
  return { mechanism, stableOutcome }
}

function architectureMechanism(
  area: typeof WEBHOOK_ARCHITECTURE_AREAS[number],
  value: string,
  rawValue: string,
): boolean {
  if (area === 'database_schema') {
    return hasAll(value, [
      /\b(?:tables?|schema|event inbox|webhook events?|payments?|wallet ledger)\b/u,
      /\b(?:unique|primary key|constraint|provider event id)\b/u,
    ])
  }
  const patterns: Record<
    Exclude<typeof WEBHOOK_ARCHITECTURE_AREAS[number], 'database_schema' | 'duplicate_handling'>,
    RegExp
  > = {
    transaction_boundaries:/\b(?:atomic transaction|begin|commit|rollback|select for update|transaction boundar\w*|same transaction)\b/u,
    state_transitions:/\b(?:state transitions?|state machine|status transitions?|payment lifecycle|event lifecycle|monotonic\w*[^.;]{0,40}transition\w*|transition\w*[^.;]{0,40}monotonic\w*|status rank)\b/u,
    pseudocode:/\b(?:pseudocode|algorithm|processing flow|handler flow|worker flow|process event|begin transaction|def|function|return|commit|insert|select)\b/u,
    out_of_order_handling:/\b(?:out of order|late event|event ordering|reorder|sequence gap|monotonic state|stale|older event|arrives late|ordering|forward only|out of sequence|earlier event\w*|arriv\w*[^.;]{0,40}(?:late|later|after|early)|(?:older|earlier|newer)[^.;]{0,40}(?:event|state|status|update)\w*|superseded|outdated|defer\w*|buffer\w*[^.;]{0,40}event\w*|(?:skip\w*|discard\w*|ignor\w*)[^.;]{0,50}(?:older|earlier|stale|outdated|out of order|out of sequence)|forward transition\w*|only forward|predecessor\w*|gap[^.;]{0,30}(?:close\w*|fill\w*))\b/u,
    failure_recovery:/\b(?:failure recovery|retryable inbox|safe replay|dead letter|crash\w*|lease recovery|re queue|requeue|retry|resume|sweeper|lease|pending events?)\b/u,
    reconciliation:/\b(?:reconciliation|reconcile|audit job|consistency check|provider poll)\b/u,
    security_checks:/\b(?:security checks?|signature verification|hmac|replay attack|replay window|timestamp validation|raw body|(?:verif\w*|validat\w*|authenticat\w*|recomput\w*|check\w*)[^.;]{0,50}(?:signature|hmac|digest|secret)|(?:signature|hmac|digest)[^.;]{0,50}(?:verif\w*|validat\w*|match\w*|mismatch\w*|reject\w*)|webhook secret|shared secret|x razorpay signature|constant time|timestamp[^.;]{0,40}(?:check\w*|validat\w*|reject\w*))\b/u,
    test_plan:/\b(?:test plan|testing strategy|test cases?|concurrency test|failure injection|integration tests?)\b|\b(?:tests?|scenarios?|coverage)\b[^.;]{0,80}\b(?:duplicate|concurren\w*|crash\w*|refund\w*|replay|out of order)\b|\b(?:duplicate|concurren\w*|crash\w*|refund\w*|replay|out of order)\b[^.;]{0,80}\b(?:tests?|scenarios?|coverage)\b/u,
  }
  if (area === 'pseudocode' && /```[\s\S]*?```/u.test(rawValue)) return true
  if (area === 'state_transitions' && /(?:->|→|=>)/u.test(rawValue)) return true
  return area !== 'duplicate_handling' && patterns[area].test(value)
}

export function evaluateWebhookArchitecture(
  answer: string,
): WebhookArchitectureEvaluation {
  const value = String(answer)
  const {
    sections, normalizedFallback, rawFallback,
  } = architectureSections(value)
  const clauses = value.split(/(?<=[.!?;])\s+|\n+/u).filter(Boolean)
  const storeHasAuthority = (clause: string, store: string): boolean => {
    const authority = '(?:source of truth|system of record|authoritative(?: store| database)?|canonical(?: store| database)?|owns? (?:the )?durable state)'
    return new RegExp(`\\b${store}\\b[^.;]{0,55}\\b${authority}\\b|\\b${authority}\\b\\s+(?:is|remains|:)\\s+(?:the\\s+)?\\b${store}\\b`, 'i').test(clause)
  }
  const storeIsSafelyNonAuthoritative = (clause: string, store: string): boolean => {
    if (!new RegExp(`\\b${store}\\b`, 'i').test(clause)) return false
    return new RegExp(`\\b${store}\\b[^.;]{0,55}\\bnon[- ]authoritative\\b|\\b${store}\\b[^.;]{0,55}\\b(?:not|never|isn't|is not|must not)\\b[^.;]{0,30}\\b(?:authoritative|source of truth|system of record|canonical)\\b|\\b${store}\\b[^.;]{0,55}\\b(?:cache|queue) only\\b|\\b${store}\\b[^.;]{0,55}\\bonly (?:a )?(?:cache|queue)\\b|\\b${store}\\b[^.;]{0,55}\\bdoes not own (?:the )?durable state\\b|\\bneither\\s+redis\\s+nor\\s+valkey\\b[^.;]{0,55}\\b(?:authoritative|source of truth|system of record|canonical)\\b`, 'i').test(clause)
  }
  const postgresAuthoritative = clauses.some(clause => (
    storeHasAuthority(clause, 'postgres(?:ql)?')
    && !storeIsSafelyNonAuthoritative(clause, 'postgres(?:ql)?')
  ))
  const stores = ['redis', 'valkey']
  const safeStores = stores.filter(store => clauses.some(
    clause => storeIsSafelyNonAuthoritative(clause, store),
  ))
  const nonPostgresAuthoritativeClaim = stores.some(store => clauses.some(clause => (
    storeHasAuthority(clause, store)
    && !storeIsSafelyNonAuthoritative(clause, store)
  )))
  const redisValkeyForbiddenAuthorityPassed = safeStores.length === stores.length
    && !nonPostgresAuthoritativeClaim
  const areaEvaluations = WEBHOOK_ARCHITECTURE_AREAS.map(areaIdentifier => {
    const section = sections.get(areaIdentifier)
    const headingPresent = section !== undefined
    const semanticValue = section?.normalizedValue ?? normalizedFallback
    const rawSemanticValue = section?.rawValue ?? rawFallback
    if (areaIdentifier === 'duplicate_handling') {
      const duplicate = duplicateArchitectureSemantics(semanticValue)
      return {
        areaIdentifier,
        headingPresent,
        semanticMechanismPresent:duplicate.mechanism,
        stableSideEffectOutcomePresent:duplicate.stableOutcome,
        passed:duplicate.mechanism || duplicate.stableOutcome,
      }
    }
    const mechanism = architectureMechanism(
      areaIdentifier, semanticValue, rawSemanticValue,
    )
    return {
      areaIdentifier,
      headingPresent,
      semanticMechanismPresent:mechanism,
      stableSideEffectOutcomePresent:false,
      passed:mechanism,
    }
  })
  const coveredAreas = areaEvaluations
    .filter(area => area.passed)
    .map(area => area.areaIdentifier)
  return {
    postgresAuthoritative,
    redisValkeyForbiddenAuthorityPassed,
    nonPostgresAuthoritativeClaim,
    coveredAreas,
    missingAreas:areaEvaluations
      .filter(area => !area.passed)
      .map(area => area.areaIdentifier),
    areaEvaluations,
    validatorVersion:CAPABILITY_SEMANTIC_VALIDATOR_VERSION,
  }
}

export function shouldRetryCapabilityCancellation(
  status: number | null,
): boolean {
  return status === null || status === 404 || (status >= 500 && status <= 599)
}

export type CapabilityTierEvidence = {
  expectedTier: 'lite' | 'standard' | 'pro'
  uiTier: string | null
  payloadTier: string | null
  auditedTier: string | null
}

export function tierEvidenceMatches(value: CapabilityTierEvidence): boolean {
  return value.uiTier === value.expectedTier
    && (value.payloadTier === null || value.payloadTier === value.expectedTier)
    && value.auditedTier === value.expectedTier
}

export function safeSummaryValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(-9e15, Math.min(9e15, value)) : 0
  }
  return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 160)
}
