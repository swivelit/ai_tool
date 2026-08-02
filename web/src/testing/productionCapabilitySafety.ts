import { randomUUID } from 'node:crypto'

export const PRODUCTION_CAPABILITY_CONFIRMATION =
  'I_UNDERSTAND_THIS_RUNS_BILLABLE_PRODUCTION_CAPABILITY_TESTS'

export const PRODUCTION_CAPABILITY_BATCHES = [
  'core', 'context', 'rag', 'repository', 'voice-ui', 'all',
] as const

export type ProductionCapabilityBatch =
  typeof PRODUCTION_CAPABILITY_BATCHES[number]

export type CapabilityEnvironment = {
  GITHUB_SHA?: string
  PLAYWRIGHT_BASE_URL?: string
  E2E_TEST_EMAIL?: string
  E2E_TEST_PASSWORD?: string
  PRODUCTION_CAPABILITY_CONFIRMATION?: string
  PRODUCTION_CAPABILITY_MAX_CHAT_DEBIT_MICROS?: string
  PRODUCTION_CAPABILITY_MAX_VOICE_DEBIT_MICROS?: string
  PRODUCTION_CAPABILITY_BATCH?: string
}

const DEPLOYMENT_SHA_PATTERN = /^[0-9a-f]{7,40}$/

export type DeploymentParityStatus = 'matched' | 'backend_release_mismatch'

export type DeploymentParityResult = {
  expectedCommitSha: string | null
  observedBackendRelease: string | null
  status: DeploymentParityStatus
  checks: number
  elapsedWaitMs: number
}

export type DeploymentParitySafeSummary = {
  expected_commit_sha: string | null
  observed_backend_release: string | null
  deployment_parity_status: DeploymentParityStatus
  deployment_parity_checks: number
  deployment_parity_elapsed_wait_ms: number
}

export class DeploymentParityError extends Error {
  readonly reasonCode = 'backend_release_mismatch'

  constructor(readonly result: DeploymentParityResult) {
    super(
      'backend_release_mismatch: deploy the latest commit to the ai_tool '
      + 'Render service, verify that the Render branch is main, and rerun '
      + 'after the backend release matches',
    )
    this.name = 'DeploymentParityError'
  }
}

export function normalizeDeploymentSha(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return DEPLOYMENT_SHA_PATTERN.test(normalized) ? normalized : null
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
  readBackendRelease: (timeoutMs: number) => Promise<unknown>
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
    }
  }
  const startedAt = now()
  let checks = 0
  let observed: string | null = null
  while (true) {
    const elapsedBeforeCheck = Math.max(0, now() - startedAt)
    if (checks > 0 && elapsedBeforeCheck >= maxWaitMs) {
      return {
        expectedCommitSha:expected, observedBackendRelease:observed,
        status:'backend_release_mismatch', checks,
        elapsedWaitMs:elapsedBeforeCheck,
      }
    }
    checks += 1
    try {
      const remainingMs = Math.max(1, maxWaitMs - elapsedBeforeCheck)
      observed = normalizeDeploymentSha(
        await options.readBackendRelease(Math.min(30_000, remainingMs)),
      )
    } catch {
      observed = null
    }
    const elapsedWaitMs = Math.max(0, now() - startedAt)
    if (deploymentShasMatch(expected, observed)) {
      return {
        expectedCommitSha:expected, observedBackendRelease:observed,
        status:'matched', checks, elapsedWaitMs,
      }
    }
    if (elapsedWaitMs >= maxWaitMs) {
      return {
        expectedCommitSha:expected, observedBackendRelease:observed,
        status:'backend_release_mismatch', checks, elapsedWaitMs,
      }
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
  }
}

export async function enforceProductionDeploymentParity(options: {
  expectedCommitSha: unknown
  readBackendRelease: (timeoutMs: number) => Promise<unknown>
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
  scenarioBatch: Exclude<ProductionCapabilityBatch, 'all'>,
): boolean {
  return selected === 'all' || selected === scenarioBatch
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

export function countSentences(value: string): number {
  const text = String(value).trim()
  if (!text) return 0
  return text.match(/[^.!?\n]+[.!?](?=\s|$)/gu)?.length ?? 0
}

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

export type WebhookArchitectureEvaluation = {
  postgresAuthoritative: boolean
  nonPostgresAuthoritativeClaim: boolean
  coveredAreas: typeof WEBHOOK_ARCHITECTURE_AREAS[number][]
  missingAreas: typeof WEBHOOK_ARCHITECTURE_AREAS[number][]
}

function hasAll(value: string, patterns: RegExp[]): boolean {
  return patterns.every(pattern => pattern.test(value))
}

export function evaluateWebhookArchitecture(
  answer: string,
): WebhookArchitectureEvaluation {
  const value = String(answer)
  const clauses = value.split(/(?<=[.!?;])\s+|\n+/u).filter(Boolean)
  const authority = /\b(?:source of truth|system of record|authoritative(?: store| database)?)\b/i
  const postgresAuthoritative = clauses.some(clause => (
    /\bpostgres(?:ql)?\b/i.test(clause)
    && authority.test(clause)
    && !/\b(?:not|never|isn't|is not|must not|cannot|can't)\b[^.;]{0,45}\b(?:source of truth|system of record|authoritative)/i.test(clause)
  ))
  const nonPostgresAuthoritativeClaim = clauses.some(clause => {
    if (!/\b(?:redis|valkey)\b/i.test(clause) || !authority.test(clause)) return false
    return !/\b(?:redis|valkey)\b[^.;]{0,60}\b(?:is|are|must|should|can|will|remains?)?\s*(?:explicitly\s+)?(?:not|never)\b[^.;]{0,45}\b(?:the\s+)?(?:source of truth|system of record|authoritative)/i.test(clause)
      && !/\b(?:not|never)\b[^.;]{0,35}\b(?:redis|valkey)\b[^.;]{0,45}\b(?:source of truth|system of record|authoritative)/i.test(clause)
      && !/\bneither\s+redis\s+nor\s+valkey\b[^.;]{0,60}\b(?:source of truth|system of record|authoritative)/i.test(clause)
  })
  const coverage: Record<typeof WEBHOOK_ARCHITECTURE_AREAS[number], boolean> = {
    database_schema:hasAll(value, [
      /\b(?:tables?|schema|event inbox|webhook events?|payments?|wallet ledger)\b/i,
      /\b(?:unique|primary key|constraint|deduplication key)\b/i,
    ]),
    transaction_boundaries:/\b(?:transaction boundaries?|atomic transaction|begin\b|commit\b|rollback\b|select for update)\b/i.test(value),
    state_transitions:/\b(?:state transitions?|state machine|status transitions?|payment lifecycle|event lifecycle)\b/i.test(value),
    pseudocode:/\b(?:pseudocode|algorithm|processing flow|handler flow|worker flow|process[_ ]?event)\b/i.test(value),
    duplicate_handling:/\b(?:duplicate(?: event)? handling|deduplicat\w*|idempotenc\w*|already processed|on conflict)\b/i.test(value),
    out_of_order_handling:/\b(?:out[- ]of[- ]order|late event|event ordering|reorder|sequence gap|monotonic state)\b/i.test(value),
    failure_recovery:/\b(?:failure recovery|retry|replay|dead[- ]letter|crash recovery|lease recovery)\b/i.test(value),
    reconciliation:/\b(?:reconciliation|reconcile|audit job|consistency check|provider poll)\b/i.test(value),
    security_checks:/\b(?:security checks?|signature verification|hmac|replay attack|timestamp validation|raw body)\b/i.test(value),
    test_plan:/\b(?:test plan|testing strategy|test cases?|concurrency test|failure injection|integration tests?)\b/i.test(value),
  }
  const coveredAreas = WEBHOOK_ARCHITECTURE_AREAS.filter(area => coverage[area])
  return {
    postgresAuthoritative,
    nonPostgresAuthoritativeClaim,
    coveredAreas,
    missingAreas:WEBHOOK_ARCHITECTURE_AREAS.filter(area => !coverage[area]),
  }
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
