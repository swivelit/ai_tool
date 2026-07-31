import type { Page, Response } from '@playwright/test'
import {
  AuthenticatedDeployedApi,
  waitForDeployedWorkspace,
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
  | 'thread_delete_failed'
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

const REQUEST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
