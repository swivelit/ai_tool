import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentContext, compactObservations } from '../dist/context.js'

test('agent context compacts observations and respects the planner request bound', () => {
  const observations = Array.from({ length: 20 }, (_, index) => `${index}:${'x'.repeat(6_000)}`)
  const compacted = compactObservations(observations)
  assert.ok(compacted.summary)
  const context = buildAgentContext({
    task: 'fix the test',
    repository: { root: '/workspace', branch: 'main', head: 'abc', dirty: true, staged: [], unstaged: [], untracked: [], gitAvailable: true },
    instructions: { files: ['AGENTS.md'], text: 'rule '.repeat(20_000), truncated: true },
    plan: [{ id: '1', description: 'inspect', state: 'in_progress' }],
    observations: compacted.observations,
    summary: compacted.summary,
  })
  assert.ok(context.length <= 20_000)
  assert.match(context, /TASK .*fix the test/s)
  assert.match(context, /REPOSITORY METADATA/) 
})
