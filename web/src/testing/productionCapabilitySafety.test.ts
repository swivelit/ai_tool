import { describe, expect, it } from 'vitest'
import {
  DebitBudget,
  PRODUCTION_CAPABILITY_CONFIRMATION,
  ProductionCapabilityGateError,
  batchIncludes,
  bulletLines,
  countSentences,
  countWords,
  parseSseEventOrder,
  percentile,
  productionCapabilityGate,
  redactPotentialSecrets,
  weightedScore,
} from './productionCapabilitySafety'

const valid = {
  PLAYWRIGHT_BASE_URL:'https://swico.example',
  E2E_TEST_EMAIL:'acceptance@example.invalid',
  E2E_TEST_PASSWORD:'not-a-real-password',
  PRODUCTION_CAPABILITY_CONFIRMATION,
  PRODUCTION_CAPABILITY_MAX_CHAT_DEBIT_MICROS:'1000',
  PRODUCTION_CAPABILITY_MAX_VOICE_DEBIT_MICROS:'2000',
  PRODUCTION_CAPABILITY_BATCH:'rag',
}

describe('production capability safety', () => {
  it('requires every production gate and positive integer caps', () => {
    expect(productionCapabilityGate(valid)).toEqual({
      batch:'rag', chatDebitCapMicros:1000, voiceDebitCapMicros:2000,
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
})
