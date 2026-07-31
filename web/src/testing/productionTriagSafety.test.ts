import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  adminAuditReasonCode,
  authenticatedHeaderReasonCode,
  bootstrapReasonCode,
  boundedCombinedFailure,
  buildProductionTriagSummary,
  loginObservationReasonCode,
  PRODUCTION_TRIAG_TEST_TIMEOUT_MS,
  productionCapabilityReasonCode,
  resolveProductionCleanup,
  workspaceShellReasonCode,
  type ProductionBootstrap,
  type ProductionSafeScenarioResult,
} from './productionTriagSafety'

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
    'upload_delete_failed',
  ])
  const combined = boundedCombinedFailure(
    'supported_pdf_failed', failedCleanup,
  )
  expect(combined).toContain('primary=supported_pdf_failed')
  expect(combined).toContain('cleanup=upload_delete_failed')
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
    source_locator:'page 1',
    provider:'private-provider',
    model:'private-model',
  } as ProductionSafeScenarioResult
  const summary = buildProductionTriagSummary({
    preflight:{ status:'passed', reason_code:'preflight_passed' },
    scenarios:[scenario],
    cleanup:{ status:'incomplete', reason_codes:['upload_delete_failed'] },
    primaryFailureReasonCode:'supported_pdf_failed',
  })
  const serialized = JSON.stringify(summary)
  expect(summary.scenarios[0].request_ids).toEqual([requestId])
  for (const forbidden of [
    'person@example.test', 'secret-password', 'secret-token', 'raw message',
    'raw answer', 'private.pdf', 'page 1', 'private-provider', 'private-model',
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
