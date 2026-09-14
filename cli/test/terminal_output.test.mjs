import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalOutput } from '../dist/terminal_output.js'

function writer(isTTY = false) {
  return { isTTY, value: '', write(chunk) { this.value += chunk } }
}

test('redirected answers stay exact while diagnostics get independent line boundaries', () => {
  const stdout = writer(false); const stderr = writer(false)
  const output = new TerminalOutput(stdout, stderr)
  output.writeAnswer('SWICO_')
  output.writeAnswer('CLI_OK')
  output.writeDiagnostic('Quality: best_effort')
  output.finishAnswer()
  assert.equal(stdout.value, 'SWICO_CLI_OK\n')
  assert.equal(stderr.value, '\nQuality: best_effort\n')
})

test('TTY diagnostics close the answer line without adding a second final newline', () => {
  const stdout = writer(true); const stderr = writer(true)
  const output = new TerminalOutput(stdout, stderr)
  output.writeAnswer('answer')
  output.writeDiagnostic('[routing]')
  output.writeDiagnostic('Quality: best_effort')
  output.writeAnswer('next')
  output.finishAnswer()
  assert.equal(stdout.value, 'answer\nnext\n')
  assert.equal(stderr.value, '[routing]\nQuality: best_effort\n')
})

test('trailing-newline and empty answers are terminated exactly once', () => {
  const firstStdout = writer(false); const firstStderr = writer(false)
  const first = new TerminalOutput(firstStdout, firstStderr)
  first.writeAnswer('already complete\n')
  first.writeDiagnostic('Quality: best_effort')
  first.finishAnswer()
  assert.equal(firstStdout.value, 'already complete\n')
  assert.equal(firstStderr.value, 'Quality: best_effort\n')

  const emptyStdout = writer(false); const emptyStderr = writer(false)
  const empty = new TerminalOutput(emptyStdout, emptyStderr)
  empty.finishAnswer()
  assert.equal(emptyStdout.value, '')
})
