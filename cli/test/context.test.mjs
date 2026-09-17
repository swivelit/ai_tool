import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { attachMentionedContext, buildAgentContext, compactObservations } from '../dist/context.js'
import { Workspace } from '../dist/workspace.js'

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

test('explicit @file and line-range mentions attach bounded hashed context only after consent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-mentions-'))
  try {
    await writeFile(join(root, 'src.ts'), 'one\ntwo\nthree\n')
    const workspace = new Workspace(root)
    const attached = await attachMentionedContext('Explain @src.ts:2-3', workspace, async () => true)
    assert.match(attached, /workspace file: src\.ts lines 2-3/)
    assert.match(attached, /two\nthree/)
    const refused = await attachMentionedContext('Explain @src.ts', workspace, async () => false)
    assert.equal(refused, 'Explain @src.ts')
    await assert.rejects(() => attachMentionedContext('Read @.env', workspace, async () => true), /safe workspace|protected/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
