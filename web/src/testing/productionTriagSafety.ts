import type { Page, Response } from '@playwright/test'
import {
  AuthenticatedDeployedApi,
  waitForDeployedWorkspace,
  type DeployedApi,
} from './deployedSafety'

export const PRODUCTION_TRIAG_TEST_TIMEOUT_MS = 20 * 60 * 1000
export const PRODUCTION_TRIAG_AUTH_TIMEOUT_MS = 90 * 1000
export const PRODUCTION_TRIAG_UNKNOWN_REQUEST_ID = '00000000-0000-4000-8000-000000000000'

export function productionTriagPdfFixture(factualValue: string): Buffer {
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

export function supportedPdfUploadStatusSubreason(
  status: number,
): ProductionScenarioSubreasonCode | null {
  if (status === 201) return null
  if (status >= 400 && status <= 499) return 'supported_pdf_upload_http_4xx'
  if (status >= 500 && status <= 599) return 'supported_pdf_upload_http_5xx'
  return 'supported_pdf_upload_response_invalid'
}

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

export type FreshChatReasonCode =
  | 'fresh_chat_button_click_failed'
  | 'fresh_chat_sidebar_open_failed'
  | 'fresh_chat_shortcut_failed'
  | 'fresh_chat_navigation_unavailable'
  | 'fresh_chat_shell_not_ready'
  | 'fresh_chat_composer_not_ready'
  | 'fresh_chat_textbox_not_empty'
  | 'fresh_chat_messages_not_cleared'
  | 'fresh_chat_attachments_not_cleared'
  | 'fresh_chat_repository_not_cleared'
  | 'fresh_chat_state_timeout'

export type FreshChatStrategy =
  | 'already_ready'
  | 'direct_button'
  | 'sidebar_button'
  | 'keyboard_shortcut'

export type ProductionScenarioSubreasonCode =
  | FreshChatReasonCode
  | 'scenario_artifact_capture_failed'
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
  | 'greeting_harness_failure'
  | 'supported_pdf_fresh_chat_failed'
  | 'supported_pdf_upload_input_missing'
  | 'supported_pdf_upload_request_not_observed'
  | 'supported_pdf_upload_http_4xx'
  | 'supported_pdf_upload_http_5xx'
  | 'supported_pdf_upload_response_invalid'
  | 'supported_pdf_upload_id_missing'
  | 'supported_pdf_attachment_not_ready'
  | 'supported_pdf_chat_request_not_observed'
  | 'supported_pdf_request_id_missing'
  | 'supported_pdf_assistant_not_visible'
  | 'supported_pdf_assistant_not_complete'
  | 'supported_pdf_sources_not_visible'
  | 'supported_pdf_audit_not_ready'
  | 'supported_pdf_document_source_missing'
  | 'supported_pdf_retrieval_not_sufficient'
  | 'supported_pdf_quality_not_grounded'
  | 'supported_pdf_harness_failure'
  | 'unsupported_pdf_chat_request_not_observed'
  | 'unsupported_pdf_request_id_missing'
  | 'unsupported_pdf_assistant_not_visible'
  | 'unsupported_pdf_assistant_not_complete'
  | 'unsupported_pdf_audit_not_ready'
  | 'unsupported_pdf_quality_invalid'
  | 'unsupported_pdf_refusal_not_visible'
  | 'unsupported_pdf_harness_failure'
  | 'knowledge_library_setup_failed'
  | 'knowledge_library_indexing_failed'
  | 'knowledge_library_fresh_chat_failed'
  | 'knowledge_library_chat_request_not_observed'
  | 'knowledge_library_request_id_missing'
  | 'knowledge_library_assistant_not_visible'
  | 'knowledge_library_assistant_not_complete'
  | 'knowledge_library_audit_not_ready'
  | 'knowledge_library_source_missing'
  | 'knowledge_library_quality_invalid'
  | 'repository_fresh_chat_failed'
  | 'repository_tier_selection_failed'
  | 'repository_upload_input_missing'
  | 'repository_upload_request_not_observed'
  | 'repository_upload_http_failure'
  | 'repository_not_ready'
  | 'repository_chat_request_not_observed'
  | 'repository_request_id_missing'
  | 'repository_assistant_not_visible'
  | 'repository_assistant_not_complete'
  | 'repository_quality_not_visible'
  | 'repository_static_only_label_missing'
  | 'repository_audit_not_ready'
  | 'repository_source_missing'
  | 'repository_quality_invalid'
  | 'repository_harness_failure'
  | 'cancellation_fresh_chat_failed'
  | 'cancellation_request_not_observed'
  | 'cancellation_request_id_missing'
  | 'cancellation_assistant_not_visible'
  | 'cancellation_stop_button_unavailable'
  | 'cancellation_not_reached'
  | 'cancellation_audit_not_ready'
  | 'cancellation_duplicate_charge'
  | 'cancellation_orphaned_reservation'
  | 'cancellation_settlement_mismatch'
  | 'cancellation_harness_failure'

export type GreetingSubreasonCode = Extract<
  ProductionScenarioSubreasonCode,
  FreshChatReasonCode | `greeting_${string}`
>

export type ProductionPrerequisiteReasonCode =
  | 'deterministic_greeting_prerequisite_failed'
  | 'supported_pdf_prerequisite_failed'

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
  subreason_code?: ProductionScenarioSubreasonCode
  fresh_chat_strategy?: FreshChatStrategy
  fresh_chat_reason_code?: FreshChatReasonCode
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

export class ProductionScenarioHarnessError extends Error {
  constructor(
    readonly reasonCode: ProductionScenarioSubreasonCode,
    readonly freshChatReasonCode?: FreshChatReasonCode,
    readonly freshChatStrategy?: FreshChatStrategy,
  ) {
    super(`Production scenario failed: ${reasonCode}`)
    this.name = 'ProductionScenarioHarnessError'
  }
}

export class GreetingHarnessError extends ProductionScenarioHarnessError {
  constructor(reasonCode: GreetingSubreasonCode) {
    super(reasonCode)
    this.name = 'GreetingHarnessError'
  }
}

export class FreshChatHarnessError extends ProductionScenarioHarnessError {
  constructor(
    readonly reasonCode: FreshChatReasonCode,
    readonly freshChatStrategy: Exclude<FreshChatStrategy, 'already_ready'>,
  ) {
    super(reasonCode, reasonCode, freshChatStrategy)
    this.name = 'FreshChatHarnessError'
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

export type FreshChatState = {
  emptyStateHeadingVisible: boolean
  conversationVisible: boolean
  composerVisible: boolean
  textboxVisible: boolean
  textboxEnabled: boolean
  textboxEmpty: boolean
  messageCount: number
  attachmentCount: number
  repositoryCount: number
}

export type FreshChatProbe = {
  readState(): Promise<FreshChatState>
  tryDirectButton(): Promise<'clicked' | 'unavailable' | 'failed'>
  trySidebarButton(
    timeoutMilliseconds: number,
  ): Promise<'clicked' | 'unavailable' | 'open_failed' | 'click_failed'>
  tryKeyboardShortcut(): Promise<'pressed' | 'unavailable' | 'failed'>
}

export function freshChatStateReason(
  state: FreshChatState,
): FreshChatReasonCode | null {
  if (!state.emptyStateHeadingVisible || !state.conversationVisible) {
    return 'fresh_chat_shell_not_ready'
  }
  if (
    !state.composerVisible
    || !state.textboxVisible
    || !state.textboxEnabled
  ) return 'fresh_chat_composer_not_ready'
  if (!state.textboxEmpty) return 'fresh_chat_textbox_not_empty'
  if (state.messageCount !== 0) return 'fresh_chat_messages_not_cleared'
  if (state.attachmentCount !== 0) {
    return 'fresh_chat_attachments_not_cleared'
  }
  if (state.repositoryCount !== 0) {
    return 'fresh_chat_repository_not_cleared'
  }
  return null
}

export function playwrightFreshChatProbe(page: Page): FreshChatProbe {
  const operationTimeoutMilliseconds = 5_000
  const boundedOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await beforeDeadline(
        operation(), Date.now() + operationTimeoutMilliseconds,
      )
    } catch {
      throw new Error('bounded fresh-chat locator operation failed')
    }
  }
  const button = page.getByTestId('new-chat-button')
  const conversation = page.getByTestId('conversation')
  const composer = page.getByTestId('composer')
  const composerContainer = composer.locator('..')
  const textbox = composer.getByRole('textbox', { name:'Message Swico' })
  return {
    async tryDirectButton() {
      try {
        if (!await boundedOperation(() => button.isVisible({
          timeout:operationTimeoutMilliseconds,
        }))) return 'unavailable'
        await boundedOperation(() => button.click({
          timeout:operationTimeoutMilliseconds,
        }))
        return 'clicked'
      } catch {
        return 'failed'
      }
    },
    async trySidebarButton(timeoutMilliseconds) {
      const trigger = page.getByRole('button', { name:'Open sidebar' })
      const timeout = Math.min(
        operationTimeoutMilliseconds, Math.max(1, timeoutMilliseconds),
      )
      try {
        if (!await boundedOperation(() => trigger.isVisible({ timeout }))) {
          return 'unavailable'
        }
        await boundedOperation(() => trigger.click({ timeout }))
        await boundedOperation(() => button.waitFor({
          state:'visible', timeout,
        }))
      } catch {
        return 'open_failed'
      }
      try {
        await boundedOperation(() => button.click({ timeout }))
        return 'clicked'
      } catch {
        return 'click_failed'
      }
    },
    async tryKeyboardShortcut() {
      if (page.isClosed()) return 'unavailable'
      try {
        await boundedOperation(() => page.keyboard.press('Control+Shift+O'))
        return 'pressed'
      } catch {
        return 'failed'
      }
    },
    async readState() {
      const [
        emptyStateHeadingVisible,
        conversationVisible,
        composerVisible,
        textboxVisible,
        textboxEnabled,
        textboxValue,
        messageCount,
        attachmentCount,
        repositoryCount,
      ] = await Promise.all([
        boundedOperation(() => conversation.getByRole('heading', {
          name:'How can I help?', exact:true,
        }).isVisible({ timeout:operationTimeoutMilliseconds })),
        boundedOperation(() => conversation.isVisible({
          timeout:operationTimeoutMilliseconds,
        })),
        boundedOperation(() => composer.isVisible({
          timeout:operationTimeoutMilliseconds,
        })),
        boundedOperation(() => textbox.isVisible({
          timeout:operationTimeoutMilliseconds,
        })),
        boundedOperation(() => textbox.isEnabled({
          timeout:operationTimeoutMilliseconds,
        })),
        boundedOperation(() => textbox.inputValue({
          timeout:operationTimeoutMilliseconds,
        })),
        boundedOperation(() => conversation.locator('article.message').count()),
        boundedOperation(() => composerContainer.locator(
          '.attachment-chip:not(.repository-chip)',
        ).count()),
        boundedOperation(() => composerContainer.locator(
          '[aria-label="Active code repository"]',
        ).count()),
      ])
      return {
        emptyStateHeadingVisible,
        conversationVisible,
        composerVisible,
        textboxVisible,
        textboxEnabled,
        textboxEmpty:textboxValue === '',
        messageCount,
        attachmentCount,
        repositoryCount,
      }
    },
  }
}

type FreshChatNavigationResult =
  | { strategy: Exclude<FreshChatStrategy, 'already_ready'> }
  | {
    reasonCode: FreshChatReasonCode
    strategy: Exclude<FreshChatStrategy, 'already_ready'>
  }

async function navigateToFreshChat(
  probe: FreshChatProbe,
  timeoutMilliseconds: number,
): Promise<FreshChatNavigationResult> {
  let fallbackReason: FreshChatReasonCode =
    'fresh_chat_navigation_unavailable'
  let fallbackStrategy: Exclude<FreshChatStrategy, 'already_ready'> =
    'keyboard_shortcut'
  let direct: Awaited<ReturnType<FreshChatProbe['tryDirectButton']>>
  try {
    direct = await probe.tryDirectButton()
  } catch {
    direct = 'failed'
  }
  if (direct === 'clicked') return { strategy:'direct_button' }
  if (direct === 'failed') {
    fallbackReason = 'fresh_chat_button_click_failed'
    fallbackStrategy = 'direct_button'
  }

  let sidebar: Awaited<ReturnType<FreshChatProbe['trySidebarButton']>>
  try {
    sidebar = await probe.trySidebarButton(timeoutMilliseconds)
  } catch {
    sidebar = 'open_failed'
  }
  if (sidebar === 'clicked') return { strategy:'sidebar_button' }
  if (sidebar === 'open_failed') {
    fallbackReason = 'fresh_chat_sidebar_open_failed'
    fallbackStrategy = 'sidebar_button'
  } else if (sidebar === 'click_failed') {
    fallbackReason = 'fresh_chat_button_click_failed'
    fallbackStrategy = 'sidebar_button'
  }

  let shortcut: Awaited<ReturnType<FreshChatProbe['tryKeyboardShortcut']>>
  try {
    shortcut = await probe.tryKeyboardShortcut()
  } catch {
    shortcut = 'failed'
  }
  if (shortcut === 'pressed') return { strategy:'keyboard_shortcut' }
  if (shortcut === 'failed') {
    return {
      reasonCode:'fresh_chat_shortcut_failed', strategy:'keyboard_shortcut',
    }
  }
  return { reasonCode:fallbackReason, strategy:fallbackStrategy }
}

export async function stabilizeFreshChat(
  probe: FreshChatProbe,
  options: {
    timeoutMilliseconds?: number
    pollMilliseconds?: number
    retryClickAfterMilliseconds?: number
  } = {},
): Promise<FreshChatStrategy> {
  const timeoutMilliseconds = Math.min(
    45_000, Math.max(1, options.timeoutMilliseconds ?? 45_000),
  )
  const pollMilliseconds = Math.max(1, options.pollMilliseconds ?? 250)
  const start = Date.now()
  const deadline = start + timeoutMilliseconds
  const retryAt = start + Math.min(
    options.retryClickAfterMilliseconds ?? 15_000,
    Math.max(1, Math.floor(timeoutMilliseconds / 2)),
  )
  try {
    if (!freshChatStateReason(await probe.readState())) return 'already_ready'
  } catch {
    // Navigation may restore a shell that is still transitioning.
  }
  let navigationAttempts = 0
  let lastStrategy: Exclude<FreshChatStrategy, 'already_ready'> | null = null
  let lastReason: FreshChatReasonCode = 'fresh_chat_state_timeout'
  while (Date.now() < deadline) {
    if (navigationAttempts === 0 || (
      navigationAttempts === 1 && Date.now() >= retryAt
    )) {
      const navigation = await navigateToFreshChat(
        probe, Math.max(1, deadline - Date.now()),
      )
      navigationAttempts += 1
      if ('reasonCode' in navigation) {
        if (!lastStrategy) {
          throw new FreshChatHarnessError(
            navigation.reasonCode, navigation.strategy,
          )
        }
      } else {
        lastStrategy = navigation.strategy
      }
    }
    try {
      const reasonCode = freshChatStateReason(await probe.readState())
      if (!reasonCode) return lastStrategy ?? 'already_ready'
      lastReason = reasonCode
    } catch {
      lastReason = 'fresh_chat_state_timeout'
    }
    await new Promise(resolveWait => setTimeout(
      resolveWait,
      Math.min(pollMilliseconds, Math.max(1, deadline - Date.now())),
    ))
  }
  throw new FreshChatHarnessError(lastReason, lastStrategy ?? 'direct_button')
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
  const identifiers = [
    value.thread_id,
    value.repository_id,
    value.continue_message_id,
    value.edit_message_id,
    value.regenerate_message_id,
  ]
  const identifiersIsolated = identifiers.every(identifier => (
    identifier === undefined || identifier === null || identifier === ''
  ))
  const attachments = value.attachment_ids
  if (
    !identifiersIsolated
    || (attachments !== undefined
      && (!Array.isArray(attachments) || attachments.length > 0))
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
    ...(item.fresh_chat_strategy
      ? { fresh_chat_strategy:item.fresh_chat_strategy } : {}),
    ...(item.fresh_chat_reason_code
      ? { fresh_chat_reason_code:item.fresh_chat_reason_code } : {}),
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
