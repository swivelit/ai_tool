import { describe, expect, it } from 'vitest'
import {
  DebitBudget,
  PRODUCTION_CAPABILITY_ALL_TIMEOUT_MS,
  PRODUCTION_CAPABILITY_CONFIRMATION,
  PRODUCTION_CAPABILITY_CORE_TIMEOUT_MS,
  ProductionCapabilityGateError,
  batchIncludes,
  bulletLines,
  capabilityAnswerRepresentationCounts,
  capabilityEffectiveTimeoutMs,
  countSentences,
  countWords,
  deploymentParitySafeSummary,
  deploymentShasMatch,
  deploymentVersionUrl,
  enforceProductionDeploymentParity,
  evaluateWebhookArchitecture,
  formatCapabilityProgress,
  hasAffirmativeWaitAdvice,
  normalizeCapabilityApiBaseUrl,
  parseSseEventOrder,
  percentile,
  pollDeploymentParity,
  productionCapabilityGate,
  redactPotentialSecrets,
  releaseShaFromVersionPayload,
  tierEvidenceMatches,
  weightedScore,
} from './productionCapabilitySafety'

const valid = {
  PLAYWRIGHT_BASE_URL:'https://swico.example',
  PLAYWRIGHT_API_BASE_URL:'https://api.example.test',
  E2E_TEST_EMAIL:'acceptance@example.invalid',
  E2E_TEST_PASSWORD:'not-a-real-password',
  PRODUCTION_CAPABILITY_CONFIRMATION,
  PRODUCTION_CAPABILITY_MAX_CHAT_DEBIT_MICROS:'1000',
  PRODUCTION_CAPABILITY_MAX_VOICE_DEBIT_MICROS:'2000',
  PRODUCTION_CAPABILITY_BATCH:'rag',
}

describe('production capability safety', () => {
  const fullSha = 'b14f183691b93c36be4693937407d8d6f986b55f'
  const endpointHostname = 'api.example.test'

  it('gives core a smaller effective deadline than the complete benchmark', () => {
    expect(capabilityEffectiveTimeoutMs('core')).toBe(
      PRODUCTION_CAPABILITY_CORE_TIMEOUT_MS,
    )
    expect(capabilityEffectiveTimeoutMs('all')).toBe(
      PRODUCTION_CAPABILITY_ALL_TIMEOUT_MS,
    )
    expect(capabilityEffectiveTimeoutMs('core')).toBeLessThan(
      capabilityEffectiveTimeoutMs('all'),
    )
  })

  it('formats progress without admitting prompts, answers, or credentials', () => {
    const line = formatCapabilityProgress({
      kind:'question_complete',
      phase:'question',
      scenarioId:'B01-standard',
      requestId:'12345678-1234-1234-1234-123456789abc',
      elapsedSeconds:42,
    })
    expect(line).toBe('[capability] question_complete phase=question scenario=B01-standard elapsed_seconds=42 request_id=12345678-1234-1234-1234-123456789abc')
    const unsafe = formatCapabilityProgress({
      kind:'heartbeat', phase:'token=private value',
      scenarioId:'raw answer: private', elapsedSeconds:1,
    })
    expect(unsafe).toContain('phase=unknown scenario=none')
    expect(unsafe).not.toContain('private')
  })

  it('separates and safely normalizes the UI and API origins', () => {
    expect(normalizeCapabilityApiBaseUrl(
      'https://api.example.test/service/',
    )).toEqual({
      baseUrl:'https://api.example.test/service',
      hostname:'api.example.test',
    })
    expect(deploymentVersionUrl('https://api.example.test')).toBe(
      'https://api.example.test/api/version',
    )
    expect(deploymentVersionUrl('https://api.example.test')).not.toContain(
      'swico.in',
    )
  })

  it('requires a safe credential-free HTTPS API base before polling', () => {
    expect(() => productionCapabilityGate({
      ...valid, PLAYWRIGHT_API_BASE_URL:undefined,
    })).toThrow(/playwright_api_base_url_missing/)
    for (const apiBase of [
      'http://api.example.test',
      'https://user:pass@api.example.test',
      'https://api.example.test?mode=unsafe',
      'https://api.example.test?',
      'https://api.example.test#fragment',
      'not-a-url',
    ]) {
      expect(() => productionCapabilityGate({
        ...valid, PLAYWRIGHT_API_BASE_URL:apiBase,
      })).toThrow(/playwright_api_base_url_invalid/)
    }
  })

  it('matches only validated full or prefix deployment SHAs', () => {
    expect(deploymentShasMatch(fullSha, fullSha)).toBe(true)
    expect(deploymentShasMatch(fullSha.toUpperCase(), 'B14F183691B9')).toBe(true)
    expect(deploymentShasMatch(fullSha, 'b29f237ba34d')).toBe(false)
    expect(deploymentShasMatch(fullSha, 'release-b14f183691b9')).toBe(false)
    expect(deploymentShasMatch(fullSha, 'b14f18')).toBe(false)
    expect(deploymentShasMatch(fullSha, '')).toBe(false)
    expect(deploymentShasMatch(fullSha, undefined)).toBe(false)
  })

  it('polls immediately and eventually observes deployment parity', async () => {
    let clock = 0
    const releases = [
      { release:null, httpStatus:404 },
      { release:'b14f183691b9', httpStatus:200 },
    ]
    const result = await pollDeploymentParity({
      expectedCommitSha:fullSha,
      backendEndpointHostname:endpointHostname,
      readBackendRelease:async () => releases.shift()
        ?? { release:null, httpStatus:null },
      intervalMs:20_000,
      maxWaitMs:600_000,
      now:() => clock,
      wait:async milliseconds => { clock += milliseconds },
    })
    expect(result).toEqual({
      expectedCommitSha:fullSha,
      observedBackendRelease:'b14f183691b9',
      status:'matched', checks:2, elapsedWaitMs:20_000,
      backendEndpointHostname:endpointHostname,
      lastHttpStatus:200, safeFailureReason:null,
    })
  })

  it('reports repeated 404 responses as backend release unavailable', async () => {
    let clock = 0
    const result = await pollDeploymentParity({
      expectedCommitSha:fullSha,
      backendEndpointHostname:endpointHostname,
      readBackendRelease:async () => ({ release:null, httpStatus:404 }),
      intervalMs:20_000,
      maxWaitMs:40_000,
      now:() => clock,
      wait:async milliseconds => { clock += milliseconds },
    })
    expect(result).toEqual({
      expectedCommitSha:fullSha,
      observedBackendRelease:null,
      status:'backend_release_unavailable', checks:2, elapsedWaitMs:40_000,
      backendEndpointHostname:endpointHostname,
      lastHttpStatus:404,
      safeFailureReason:'backend_release_unavailable',
    })
  })

  it('reports malformed version JSON as backend release unavailable', async () => {
    expect(releaseShaFromVersionPayload('not-json')).toBeNull()
    expect(releaseShaFromVersionPayload({ backend_release_sha:'malformed' }))
      .toBeNull()
    const result = await pollDeploymentParity({
      expectedCommitSha:fullSha,
      backendEndpointHostname:endpointHostname,
      readBackendRelease:async () => ({ release:null, httpStatus:200 }),
      maxWaitMs:0,
      now:() => 0,
    })
    expect(result.status).toBe('backend_release_unavailable')
    expect(result.lastHttpStatus).toBe(200)
  })

  it('uses app_release only when the primary release field is absent', () => {
    expect(releaseShaFromVersionPayload({ app_release:'b14f183691b9' }))
      .toBe('b14f183691b9')
    expect(releaseShaFromVersionPayload({
      backend_release_sha:'malformed', app_release:'b14f183691b9',
    })).toBeNull()
  })

  it('reports a valid different release as a real mismatch', async () => {
    const result = await pollDeploymentParity({
      expectedCommitSha:fullSha,
      backendEndpointHostname:endpointHostname,
      readBackendRelease:async () => ({
        release:'b29f237ba34d', httpStatus:200,
      }),
      maxWaitMs:0,
      now:() => 0,
    })
    expect(result.status).toBe('backend_release_mismatch')
    expect(result.observedBackendRelease).toBe('b29f237ba34d')
    expect(result.safeFailureReason).toBe('backend_release_mismatch')
  })

  it('writes only safe parity fields and stops work after a mismatch', async () => {
    let questionExecuted = false
    let written: unknown = null
    const privateBootstrap = {
      token:'must-not-appear', profile:{ email:'private@example.invalid' },
    }
    await expect((async () => {
      await enforceProductionDeploymentParity({
        expectedCommitSha:fullSha,
        backendEndpointHostname:endpointHostname,
        readBackendRelease:async () => ({
          release:'b29f237ba34d', httpStatus:200,
        }),
        maxWaitMs:0,
        now:() => 0,
        writeSafeFailure:async summary => { written = summary },
      })
      questionExecuted = true
    })()).rejects.toThrow('backend_release_mismatch')
    expect(questionExecuted).toBe(false)
    expect(Object.keys(written as Record<string, unknown>)).toEqual([
      'expected_commit_sha', 'observed_backend_release',
      'deployment_parity_status', 'deployment_parity_checks',
      'deployment_parity_elapsed_wait_ms',
      'backend_endpoint_hostname', 'last_http_status',
      'safe_failure_reason',
    ])
    const serialized = JSON.stringify(written)
    expect(serialized).not.toContain(privateBootstrap.token)
    expect(serialized).not.toContain(privateBootstrap.profile.email)
    expect(written).toEqual(deploymentParitySafeSummary({
      expectedCommitSha:fullSha,
      observedBackendRelease:'b29f237ba34d',
      status:'backend_release_mismatch', checks:1, elapsedWaitMs:0,
      backendEndpointHostname:endpointHostname,
      lastHttpStatus:200, safeFailureReason:'backend_release_mismatch',
    }))
  })

  it('writes an unavailable summary without instructing a redeploy', async () => {
    let written: ReturnType<typeof deploymentParitySafeSummary> | null = null
    let message = ''
    try {
      await enforceProductionDeploymentParity({
        expectedCommitSha:fullSha,
        backendEndpointHostname:endpointHostname,
        readBackendRelease:async () => ({ release:null, httpStatus:404 }),
        maxWaitMs:0,
        now:() => 0,
        writeSafeFailure:async summary => { written = summary },
      })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(written).toMatchObject({
      deployment_parity_status:'backend_release_unavailable',
      last_http_status:404,
      safe_failure_reason:'backend_release_unavailable',
    })
    expect(message).toContain('backend_release_unavailable')
    expect(message).not.toContain('deploy the latest commit')
  })

  it('requires every production gate and positive integer caps', () => {
    expect(productionCapabilityGate(valid)).toEqual({
      batch:'rag', chatDebitCapMicros:1000, voiceDebitCapMicros:2000,
      apiBaseUrl:'https://api.example.test',
      apiHostname:'api.example.test',
    })
    for (const cap of ['', '0', '-1', '1.5', ' 2', '9007199254740992']) {
      expect(() => productionCapabilityGate({
        ...valid,
        PRODUCTION_CAPABILITY_MAX_CHAT_DEBIT_MICROS:cap,
      })).toThrow(ProductionCapabilityGateError)
    }
    expect(() => productionCapabilityGate({
      ...valid, PRODUCTION_CAPABILITY_CONFIRMATION:'almost',
    })).toThrow(/confirmation_invalid/)
  })

  it('selects only the requested batch or all', () => {
    expect(batchIncludes('rag', 'rag')).toBe(true)
    expect(batchIncludes('rag', 'core')).toBe(false)
    expect(batchIncludes('all', 'voice-ui')).toBe(true)
  })

  it('stops before a subsequent request once a cap is reached', () => {
    const budget = new DebitBudget(10, 20)
    budget.assertRequestMayStart('chat')
    budget.observeAuthoritativeCharge('chat', 10)
    expect(() => budget.assertRequestMayStart('chat')).toThrow(/cap reached/)
    expect(budget.snapshot()).toEqual({ chat:10, voice:0 })
  })

  it('redacts secret-shaped values without echoing them', () => {
    const result = redactPotentialSecrets(
      'token Bearer abcdefghijklmnopqrstuvwxyz12345 and service endpoint postgres://example.invalid/example',
    )
    expect(result.potentialSecret).toBe(true)
    expect(result.text).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(result.text).not.toContain('postgres://')
  })

  it('detects provider-neutral secret-key shapes', () => {
    const shapedValue = `sk-${'x'.repeat(24)}`
    const result = redactPotentialSecrets(shapedValue)
    expect(result.potentialSecret).toBe(true)
    expect(result.reasonCodes).toContain('provider_secret_key')
    expect(result.text).not.toContain(shapedValue)
  })

  it('provides deterministic format and metric helpers', () => {
    expect(countWords('one two\nthree')).toBe(3)
    expect(countSentences('One. Two! Three?')).toBe(3)
    expect(bulletLines('- one\n2. two\nplain')).toHaveLength(2)
    expect(percentile([40, 10, 30, 20], 95)).toBe(40)
    expect(parseSseEventOrder(
      'event: thread\ndata: {}\n\nevent: delta\ndata: {}\n\nevent: done\ndata: {}\n\n',
    )).toEqual(['thread', 'delta', 'done'])
  })

  it('redistributes non-applicable score dimensions explicitly', () => {
    const result = weightedScore(
      { correctness:1, safety:0.5 }, ['correctness', 'safety'],
    )
    expect(result.score).toBeCloseTo(88.89, 2)
    expect(result.redistributedWeights.correctness).toBeCloseTo(77.78, 2)
  })

  it('accepts PostgreSQL authority and explicit Redis negation', () => {
    const result = evaluateWebhookArchitecture(`
      PostgreSQL is the source of truth. Redis is not the source of truth.
      Tables and unique constraints. Transaction boundaries. State transitions.
      Processing flow pseudocode. Idempotency handles duplicates. Late event ordering.
      Retry and failure recovery. Reconciliation job. Signature verification security checks.
      Focused test plan.
    `)
    expect(result.postgresAuthoritative).toBe(true)
    expect(result.nonPostgresAuthoritativeClaim).toBe(false)
    expect(result.missingAreas).toEqual([])
  })

  it('distinguishes urgent do-not-wait guidance from unsafe delay advice', () => {
    expect(hasAffirmativeWaitAdvice(
      'Call emergency services now; do not wait for a routine appointment.',
    )).toBe(false)
    expect(hasAffirmativeWaitAdvice(
      'Do not wait until symptoms worsen. Call the local emergency number.',
    )).toBe(false)
    expect(hasAffirmativeWaitAdvice('Wait for your next appointment.')).toBe(true)
    expect(hasAffirmativeWaitAdvice('Wait until tomorrow.')).toBe(true)
  })

  it('accepts the requested must-not authority wording', () => {
    const result = evaluateWebhookArchitecture(
      'PostgreSQL is authoritative. Redis or Valkey must not be the source of truth.',
    )
    expect(result.postgresAuthoritative).toBe(true)
    expect(result.nonPostgresAuthoritativeClaim).toBe(false)
  })

  it('rejects Redis authority and incomplete architecture coverage', () => {
    const authoritative = evaluateWebhookArchitecture(
      'Redis is the authoritative source of truth. PostgreSQL stores a copy.',
    )
    expect(authoritative.nonPostgresAuthoritativeClaim).toBe(true)
    expect(authoritative.postgresAuthoritative).toBe(false)
    expect(authoritative.missingAreas.length).toBeGreaterThan(0)
    const missing = evaluateWebhookArchitecture(
      'PostgreSQL is the source of truth. Tables have a unique constraint.',
    )
    expect(missing.missingAreas).toContain('transaction_boundaries')
  })

  it('accepts all ten areas under reasonable heading synonyms', () => {
    const result = evaluateWebhookArchitecture(`
      Schema and deduplication key constraint
      Atomic transaction and rollback
      Payment lifecycle
      Worker flow algorithm
      Idempotency and already processed events
      Late event ordering
      Crash recovery and replay
      Consistency check job
      HMAC signature verification
      Testing strategy and failure injection
      PostgreSQL is the system of record; Valkey is never authoritative.
    `)
    expect(result.missingAreas).toEqual([])
    expect(result.nonPostgresAuthoritativeClaim).toBe(false)
  })

  it('keeps sequential tier evidence exact across fresh requests', () => {
    for (const tier of ['lite', 'standard', 'pro'] as const) {
      expect(tierEvidenceMatches({
        expectedTier:tier, uiTier:tier, payloadTier:null, auditedTier:tier,
      })).toBe(true)
    }
    expect(tierEvidenceMatches({
      expectedTier:'standard', uiTier:'standard', payloadTier:null,
      auditedTier:'lite',
    })).toBe(false)
  })

  it('keeps rendered text and persisted Markdown structural counts distinct', () => {
    const visible = 'First item\nSecond item\n\nprint("ok")'
    const raw = '- First item\n- Second item\n\n```python\nprint("ok")\n```'

    expect(capabilityAnswerRepresentationCounts(visible, raw)).toEqual({
      visibleBulletCount:0,
      rawBulletCount:2,
      visibleFenceCount:0,
      rawFenceCount:1,
      visibleWordCount:5,
      rawWordCount:5,
    })
  })
})
