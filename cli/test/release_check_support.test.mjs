import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLEAN_INSTALL_TIMEOUT_MS,
  DEFAULT_STAGE_TIMEOUT_MS,
  DIAGNOSTIC_OUTPUT_LIMIT,
  classifyExecFailure,
  timeoutForStage,
} from '../scripts/release-check-support.mjs'

describe('release-check stage timeout handling', () => {
  it('keeps ordinary stages at 90 seconds and gives clean install its dedicated budget', () => {
    assert.equal(DEFAULT_STAGE_TIMEOUT_MS, 90_000)
    assert.equal(timeoutForStage('pack'), DEFAULT_STAGE_TIMEOUT_MS)
    assert.equal(timeoutForStage('installed --help'), DEFAULT_STAGE_TIMEOUT_MS)
    assert.equal(timeoutForStage('clean-prefix install'), CLEAN_INSTALL_TIMEOUT_MS)
    assert.equal(CLEAN_INSTALL_TIMEOUT_MS, 240_000)
  })

  it('classifies a killed process near its configured timeout without relying on timedOut', () => {
    const diagnostic = classifyExecFailure({
      label: 'clean-prefix install',
      error: { killed: true, signal: 'SIGTERM', code: null, stdout: 'out', stderr: 'err' },
      startedAt: 1_000,
      timeoutMs: CLEAN_INSTALL_TIMEOUT_MS,
      now: 241_037,
    })
    assert.equal(diagnostic.timed_out, true)
    assert.equal(diagnostic.elapsed_ms, 240_037)
    assert.equal(diagnostic.killed, true)
    assert.equal(diagnostic.signal, 'SIGTERM')
    assert.equal(diagnostic.code, null)
  })

  it('does not mislabel a genuine nonzero process failure as a timeout', () => {
    const diagnostic = classifyExecFailure({
      label: 'installed --help',
      error: { killed: false, signal: null, code: 1, stdout: 'out', stderr: 'failure' },
      startedAt: 1_000,
      timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
      now: 2_250,
    })
    assert.equal(diagnostic.timed_out, false)
    assert.equal(diagnostic.killed, false)
    assert.equal(diagnostic.code, 1)
  })

  it('bounds captured output', () => {
    const diagnostic = classifyExecFailure({
      label: 'pack',
      error: { stdout: 'o'.repeat(10_000), stderr: 'e'.repeat(10_000) },
      startedAt: 1_000,
      timeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
      now: 2_000,
    })
    assert.equal(diagnostic.stdout.length, DIAGNOSTIC_OUTPUT_LIMIT)
    assert.equal(diagnostic.stderr.length, DIAGNOSTIC_OUTPUT_LIMIT)
    assert.equal(diagnostic.timed_out, false)
  })
})
