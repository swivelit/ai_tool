import type { Page, Response } from '@playwright/test'
import {
  AuthenticatedDeployedApi,
  waitForDeployedWorkspace,
  type DeployedApi,
} from './deployedSafety'

export const PRODUCTION_TRIAG_TEST_TIMEOUT_MS = 20 * 60 * 1000
export const PRODUCTION_TRIAG_AUTH_TIMEOUT_MS = 90 * 1000
export const PRODUCTION_TRIAG_UNKNOWN_REQUEST_ID = '00000000-0000-4000-8000-000000000000'

export type ProductionPreflightReasonCode =
  | 'login_form_unavailable'
  | 'firebase_login_rejected'
  | 'bootstrap_not_observed'
  | 'bootstrap_http_401'
  | 'bootstrap_http_403'
  | 'bootstrap_http_5xx'
  | 'authenticated_request_header_missing'
  | 'workspace_shell_not_ready'
  | 'workspace_capability_missing'
  | 'attachments_capability_missing'
  | 'knowledge_library_capability_missing'
  | 'repository_upload_capability_missing'
  | 'repository_chat_capability_missing'
  | 'validator_capability_missing'
  | 'assistant_tier_missing'
  | 'internal_account_required'
  | 'admin_audit_access_denied'
  | 'preflight_passed'

export type ProductionCleanupReasonCode =
  | 'thread_discovery_failed'
  | 'thread_delete_http_failure'
  | 'thread_delete_response_parse_failure'
  | 'thread_delete_verification_failure'
  | 'thread_delete_rate_limited'
  | 'thread_verification_failed'
  | 'knowledge_delete_failed'
  | 'repository_delete_failed'
  | 'upload_delete_failed'
  | 'tier_restore_failed'
  | 'logout_failed'

export type ProductionCleanup = {
  status: 'not_required' | 'complete' | 'incomplete'
  reason_codes: ProductionCleanupReasonCode[]
}

export type ProductionScenarioName =
  | 'deterministic_greeting'
  | 'supported_pdf'
  | 'unsupported_pdf'
  | 'knowledge_library'
  | 'repository_pro'
  | 'cancellation_settlement'

export type ProductionScenarioReasonCode =
  | 'deterministic_greeting_failed'
  | 'supported_pdf_failed'
  | 'unsupported_pdf_failed'
  | 'knowledge_library_failed'
  | 'repository_pro_failed'
  | 'cancellation_settlement_failed'

export type GreetingSubreasonCode =
  | 'greeting_request_not_observed'
  | 'greeting_request_id_missing'
  | 'greeting_payload_not_isolated'
  | 'greeting_assistant_not_visible'
  | 'greeting_assistant_not_complete'
  | 'greeting_response_empty'
  | 'greeting_wallet_read_failed'
  | 'greeting_wallet_changed'
  | 'greeting_audit_not_ready'
  | 'greeting_provider_call_detected'
  | 'greeting_nonzero_charge'
  | 'greeting_paid_stage_detected'
  | 'greeting_duplicate_settlement'

export type ProductionPrerequisiteReasonCode =
  'deterministic_greeting_prerequisite_failed'

export type ProductionPrimaryFailureReasonCode =
  | Exclude<ProductionPreflightReasonCode, 'preflight_passed'>
  | 'production_write_confirmation_missing'
  | 'thread_snapshot_failed'
  | 'knowledge_snapshot_failed'
  | 'unexpected_harness_failure'
  | ProductionScenarioReasonCode
  | 'none'

export type ProductionSafeScenarioResult = {
  scenario: ProductionScenarioName
  status: 'passed' | 'failed' | 'not_run'
  request_ids: string[]
  reason_code?: ProductionScenarioReasonCode
  subreason_code?: GreetingSubreasonCode
  prerequisite_reason_code?: ProductionPrerequisiteReasonCode
}

export type ProductionSafeSummary = {
  schema_version: 2
  result: 'passed' | 'failed'
  preflight: {
    status: 'passed' | 'failed'
    reason_code: ProductionPreflightReasonCode
  }
  scenarios: ProductionSafeScenarioResult[]
  cleanup: ProductionCleanup
  primary_failure_reason_code: ProductionPrimaryFailureReasonCode
}

export type ProductionBootstrap = {
  wallet: { billing_exempt?: boolean }
  features: {
    web_attachments: boolean
    web_knowledge_library: boolean
    web_repository_upload: boolean
    web_repository_chat: boolean
  }
  repositories: { validation_capability: 'static_only' | 'executable' }
  assistant: { tier: 'lite' | 'standard' | 'pro' }
}

export class ProductionPreflightError extends Error {
  constructor(
    readonly reasonCode: Exclude<ProductionPreflightReasonCode, 'preflight_passed'>,
    readonly authenticationSucceeded = false,
    readonly api: AuthenticatedDeployedApi | null = null,
  ) {
    super(`Production TRIAG preflight failed: ${reasonCode}`)
    this.name = 'ProductionPreflightError'
  }
}

export class GreetingHarnessError extends Error {
  constructor(readonly reasonCode: GreetingSubreasonCode) {
    super(`Deterministic greeting failed: ${reasonCode}`)
    this.name = 'GreetingHarnessError'
  }
}

export type GreetingAuditState = {
  provider_call_count: number
  charged_micro_inr_total: number
  settled_micro_inr_total: number
  paid_usage_stage_count: number
  duplicate_settlement_indicator: boolean
  cancellation_state: string
  orphaned_active_reservation: boolean
}

const REQUEST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isProductionRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_UUID.test(value)
}

export function assertIsolatedGreetingPayload(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new GreetingHarnessError('greeting_payload_not_isolated')
  }
  const value = payload as Record<string, unknown>
  const attachments = value.attachment_ids
  if (
    'thread_id' in value
    || 'repository_id' in value
    || (attachments !== undefined && (
      !Array.isArray(attachments) || attachments.length > 0
    ))
  ) throw new GreetingHarnessError('greeting_payload_not_isolated')
}

export function greetingAuditSubreason(
  audit: GreetingAuditState,
): GreetingSubreasonCode | null {
  if (
    audit.cancellation_state !== 'complete'
    || audit.orphaned_active_reservation !== false
  ) return 'greeting_audit_not_ready'
  if (audit.provider_call_count !== 0) {
    return 'greeting_provider_call_detected'
  }
  if (
    audit.charged_micro_inr_total !== 0
    || audit.settled_micro_inr_total !== 0
  ) return 'greeting_nonzero_charge'
  if (audit.paid_usage_stage_count !== 0) {
    return 'greeting_paid_stage_detected'
  }
  if (audit.duplicate_settlement_indicator !== false) {
    return 'greeting_duplicate_settlement'
  }
  return null
}

export function assertGreetingAudit(audit: GreetingAuditState): void {
  const reasonCode = greetingAuditSubreason(audit)
  if (reasonCode) throw new GreetingHarnessError(reasonCode)
}

export async function pollTerminalGreetingAudit<T extends GreetingAuditState>(
  api: DeployedApi,
  requestId: string,
  options: { timeoutMilliseconds?: number; intervalMilliseconds?: number } = {},
): Promise<T> {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000
  const intervalMilliseconds = options.intervalMilliseconds ?? 500
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      const response = await api.request<{ results: T[] }>(
        'POST', '/api/web/admin/triag-request-audit',
        { request_ids:[requestId] },
      )
      const current = response.status === 200
        ? response.data?.results[0] : undefined
      if (current?.cancellation_state === 'complete') return current
    } catch {
      // Audit creation and terminal settlement are eventually consistent.
    }
    await new Promise(resolveWait => setTimeout(
      resolveWait, Math.min(intervalMilliseconds, Math.max(1, deadline - Date.now())),
    ))
  }
  throw new GreetingHarnessError('greeting_audit_not_ready')
}

export function bootstrapReasonCode(status: number): ProductionPreflightReasonCode {
  if (status === 200) return 'preflight_passed'
  if (status === 401) return 'bootstrap_http_401'
  if (status === 403) return 'bootstrap_http_403'
  if (status >= 500 && status <= 599) return 'bootstrap_http_5xx'
  return 'bootstrap_not_observed'
}

export function adminAuditReasonCode(status: number): ProductionPreflightReasonCode {
  return status === 404 ? 'preflight_passed' : 'admin_audit_access_denied'
}

export function loginObservationReasonCode(
  observation: 'firebase_rejected' | 'not_observed',
): ProductionPreflightReasonCode {
  return observation === 'firebase_rejected'
    ? 'firebase_login_rejected' : 'bootstrap_not_observed'
}

export function authenticatedHeaderReasonCode(
  authorization: string | undefined,
): ProductionPreflightReasonCode {
  return authorization?.startsWith('Bearer ')
    ? 'preflight_passed' : 'authenticated_request_header_missing'
}

export function workspaceShellReasonCode(
  ready: boolean,
): ProductionPreflightReasonCode {
  return ready ? 'preflight_passed' : 'workspace_shell_not_ready'
}

export function productionCapabilityReasonCode(
  bootstrap: ProductionBootstrap | null | undefined,
): ProductionPreflightReasonCode {
  if (
    !bootstrap
    || !bootstrap.wallet
    || !bootstrap.features
    || !bootstrap.repositories
    || !bootstrap.assistant
  ) return 'workspace_capability_missing'
  if (bootstrap.features.web_attachments !== true) {
    return 'attachments_capability_missing'
  }
  if (bootstrap.features.web_knowledge_library !== true) {
    return 'knowledge_library_capability_missing'
  }
  if (bootstrap.features.web_repository_upload !== true) {
    return 'repository_upload_capability_missing'
  }
  if (bootstrap.features.web_repository_chat !== true) {
    return 'repository_chat_capability_missing'
  }
  if (!['static_only', 'executable'].includes(
    bootstrap.repositories.validation_capability,
  )) return 'validator_capability_missing'
  if (!['lite', 'standard', 'pro'].includes(bootstrap.assistant.tier)) {
    return 'assistant_tier_missing'
  }
  return 'preflight_passed'
}

export function resolveProductionCleanup(
  authenticationSucceeded: boolean,
  productionMutationsBegan: boolean,
  reasonCodes: ProductionCleanupReasonCode[],
): ProductionCleanup {
  const uniqueReasonCodes = [...new Set(reasonCodes)]
  if (uniqueReasonCodes.length > 0) {
    return { status:'incomplete', reason_codes:uniqueReasonCodes }
  }
  return {
    status:authenticationSucceeded && productionMutationsBegan
      ? 'complete' : 'not_required',
    reason_codes:[],
  }
}

export function boundedCombinedFailure(
  primaryReasonCode: ProductionPrimaryFailureReasonCode,
  cleanup: ProductionCleanup,
): string {
  const cleanupCodes = cleanup.reason_codes.length > 0
    ? cleanup.reason_codes.join(',') : 'none'
  return `production_triag_failed primary=${primaryReasonCode} cleanup_status=${cleanup.status} cleanup=${cleanupCodes}`
}

export function buildProductionTriagSummary(input: {
  preflight: ProductionSafeSummary['preflight']
  scenarios: ProductionSafeScenarioResult[]
  cleanup: ProductionCleanup
  primaryFailureReasonCode: ProductionPrimaryFailureReasonCode
}): ProductionSafeSummary {
  const scenarios = input.scenarios.map(item => ({
    scenario:item.scenario,
    status:item.status,
    request_ids:item.request_ids.filter(value => REQUEST_UUID.test(value)),
    ...(item.status === 'failed' && item.reason_code
      ? { reason_code:item.reason_code } : {}),
    ...(item.status === 'failed' && item.subreason_code
      ? { subreason_code:item.subreason_code } : {}),
    ...(item.status === 'not_run' && item.prerequisite_reason_code
      ? { prerequisite_reason_code:item.prerequisite_reason_code } : {}),
  }))
  return {
    schema_version:2,
    result:input.primaryFailureReasonCode === 'none'
      && scenarios.every(item => item.status === 'passed')
      && input.cleanup.status === 'complete' ? 'passed' : 'failed',
    preflight:{
      status:input.preflight.status,
      reason_code:input.preflight.reason_code,
    },
    scenarios,
    cleanup:{
      status:input.cleanup.status,
      reason_codes:[...input.cleanup.reason_codes],
    },
    primary_failure_reason_code:input.primaryFailureReasonCode,
  }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('bounded timeout')), remaining(deadline))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function fail(
  reasonCode: Exclude<ProductionPreflightReasonCode, 'preflight_passed'>,
  authenticationSucceeded = false,
  api: AuthenticatedDeployedApi | null = null,
): never {
  throw new ProductionPreflightError(
    reasonCode, authenticationSucceeded, api,
  )
}

type LoginObservation =
  | { kind: 'bootstrap'; response: Response }
  | { kind: 'firebase_rejected' }
  | { kind: 'not_observed' }

export async function loginProductionTriag<TBootstrap extends ProductionBootstrap>(
  page: Page,
  email: string,
  password: string,
  timeoutMilliseconds = PRODUCTION_TRIAG_AUTH_TIMEOUT_MS,
): Promise<{
  api: AuthenticatedDeployedApi
  bootstrap: TBootstrap
  reasonCode: 'preflight_passed'
}> {
  const deadline = Date.now() + timeoutMilliseconds
  if (!email || !password) fail('firebase_login_rejected')

  try {
    await page.goto('/', {
      waitUntil:'domcontentloaded',
      timeout:Math.min(30_000, remaining(deadline)),
    })
    await Promise.all([
      page.getByLabel('Email address').waitFor({
        state:'visible', timeout:Math.min(20_000, remaining(deadline)),
      }),
      page.getByLabel('Password', { exact:true }).waitFor({
        state:'visible', timeout:Math.min(20_000, remaining(deadline)),
      }),
      page.getByRole('button', { name:'Sign in' }).waitFor({
        state:'visible', timeout:Math.min(20_000, remaining(deadline)),
      }),
    ])
  } catch {
    fail('login_form_unavailable')
  }

  const bootstrapObservation = page.waitForResponse(response => (
    new URL(response.url()).pathname === '/api/web/bootstrap'
  ), { timeout:remaining(deadline) }).then<LoginObservation>(response => ({
    kind:'bootstrap', response,
  })).catch<LoginObservation>(() => ({ kind:'not_observed' }))
  const visibleLoginError = page.getByRole('alert').waitFor({
    state:'visible', timeout:remaining(deadline),
  }).then<LoginObservation>(() => ({ kind:'firebase_rejected' }))
    .catch<LoginObservation>(() => ({ kind:'not_observed' }))

  try {
    await page.getByLabel('Email address').fill(email, {
      timeout:remaining(deadline),
    })
    await page.getByLabel('Password', { exact:true }).fill(password, {
      timeout:remaining(deadline),
    })
    await page.getByRole('button', { name:'Sign in' }).click({
      timeout:remaining(deadline),
    })
  } catch {
    fail('login_form_unavailable')
  }

  const observation = await Promise.race([
    bootstrapObservation,
    visibleLoginError,
  ])
  if (observation.kind !== 'bootstrap') {
    fail(loginObservationReasonCode(observation.kind) as Exclude<
      ProductionPreflightReasonCode, 'preflight_passed'
    >)
  }

  const bootstrapCode = bootstrapReasonCode(observation.response.status())
  if (bootstrapCode !== 'preflight_passed') fail(bootstrapCode)
  let authorization: string | undefined
  try {
    authorization = (
      await observation.response.request().allHeaders()
    ).authorization
  } catch {
    fail('authenticated_request_header_missing', true)
  }
  const headerCode = authenticatedHeaderReasonCode(authorization)
  if (headerCode !== 'preflight_passed') fail(headerCode, true)

  const api = new AuthenticatedDeployedApi(
    page.request,
    new URL(observation.response.url()).origin,
    authorization!,
  )

  let bootstrap: TBootstrap
  try {
    bootstrap = await observation.response.json() as TBootstrap
  } catch {
    fail('workspace_capability_missing', true, api)
  }
  try {
    await waitForDeployedWorkspace(page, remaining(deadline))
  } catch {
    fail('workspace_shell_not_ready', true, api)
  }
  const capabilityCode = productionCapabilityReasonCode(bootstrap)
  if (capabilityCode !== 'preflight_passed') {
    fail(capabilityCode, true, api)
  }
  if (bootstrap.wallet.billing_exempt !== true) {
    fail('internal_account_required', true, api)
  }
  let auditStatus = 0
  try {
    const audit = await beforeDeadline(
      api.request<never>(
        'POST',
        '/api/web/admin/triag-request-audit',
        { request_ids:[PRODUCTION_TRIAG_UNKNOWN_REQUEST_ID] },
      ),
      deadline,
    )
    auditStatus = audit.status
  } catch {
    fail('admin_audit_access_denied', true, api)
  }
  if (adminAuditReasonCode(auditStatus) !== 'preflight_passed') {
    fail('admin_audit_access_denied', true, api)
  }
  return { api, bootstrap, reasonCode:'preflight_passed' }
}
