import { describe, expect, it } from 'vitest'
import {
  ALL_CAPABILITY_QUESTIONS,
  CORE_QUESTIONS,
  materializeQuestion,
} from '../../e2e/productionCapabilityQuestionBank'

describe('production capability question bank', () => {
  it('preserves every required public question id', () => {
    const ids = new Set(ALL_CAPABILITY_QUESTIONS.map(item => item.id))
    for (const prefix of [
      ['A', 9], ['B', 3], ['C', 9], ['D', 5], ['E', 9],
      ['F', 4], ['G', 5], ['H', 5], ['I', 4],
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

  it('materializes only synthetic run markers', () => {
    const memory = ALL_CAPABILITY_QUESTIONS.find(item => item.id === 'H01')!
    expect(materializeQuestion(memory, 'SAFE-RUN').prompt).toContain('ORBIT-SAFE-RUN')
  })
})
