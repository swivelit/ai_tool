import { describe, expect, it } from 'vitest'
import {
  ALL_CAPABILITY_QUESTIONS,
  CORE_QUESTIONS,
  ROUTING_QUESTIONS,
  materializeQuestion,
} from '../../e2e/productionCapabilityQuestionBank'
import { assertUniqueCapabilityScenarioIds } from './productionCapabilitySafety'

describe('production capability question bank', () => {
  it('preserves every required public question id', () => {
    const ids = new Set(ALL_CAPABILITY_QUESTIONS.map(item => item.id))
    for (const prefix of [
      ['A', 9], ['B', 3], ['C', 9], ['D', 5], ['E', 9],
      ['F', 4], ['G', 5], ['H', 5], ['I', 4],
      ['R', 10],
    ] as const) {
      for (let index = 1; index <= prefix[1]; index += 1) {
        expect(ids.has(`${prefix[0]}${String(index).padStart(2, '0')}`)).toBe(true)
      }
    }
  })

  it('contains exactly three tier runs for each controlled comparison', () => {
    for (const id of ['B01', 'B02', 'B03']) {
      expect(CORE_QUESTIONS.filter(item => item.id === id).map(item => item.tier))
        .toEqual(['lite', 'standard', 'pro'])
    }
  })

  it('has unique scenario ids including the edited continuity branch', () => {
    const ids = ALL_CAPABILITY_QUESTIONS.map(item => (
      item.tier ? `${item.id}-${item.tier}` : item.id
    ))
    expect(() => assertUniqueCapabilityScenarioIds([
      ...ids, 'D06-EDIT-standard',
    ])).not.toThrow()
  })

  it('materializes only synthetic run markers', () => {
    const memory = ALL_CAPABILITY_QUESTIONS.find(item => item.id === 'H01')!
    expect(materializeQuestion(memory, 'SAFE-RUN').prompt).toContain('ORBIT-SAFE-RUN')
  })

  it('defines the routing batch with fresh isolated threads and route probes', () => {
    expect(ROUTING_QUESTIONS).toHaveLength(10)
    expect(ROUTING_QUESTIONS.every(item => (
      item.batch === 'routing' && item.freshThread === true
    ))).toBe(true)
    expect(ROUTING_QUESTIONS.find(item => item.id === 'R01')?.prompt)
      .toContain('Pricing — show the available plans')
    expect(ROUTING_QUESTIONS.find(item => item.id === 'R04')?.prompt.length)
      .toBeGreaterThan(240)
    expect(ROUTING_QUESTIONS.find(item => item.id === 'R06')?.prompt.split('\n'))
      .toHaveLength(3)
    expect(ROUTING_QUESTIONS.find(item => item.id === 'R07')?.prompt)
      .toBe("Swico plans enna, pricing sollunga?")
    expect(ROUTING_QUESTIONS.find(item => item.id === 'R10')?.prompt)
      .toBe('What is the most likely failure mode, and what should I change first?')
  })
})
