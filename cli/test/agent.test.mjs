import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../dist/workspace.js'
import { LocalAgent } from '../dist/agent.js'

test('LocalAgent executes a production action and replays its journal without rerunning it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-agent-'))
  const journal = join(root, 'journal.jsonl')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'main.ts'), 'export const answer = 42\n')
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body })
    if (String(url).endsWith('/actions')) return new Response(JSON.stringify({ action_id: 'list-action', status: 'accepted' }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (String(url).endsWith('/result')) return new Response(JSON.stringify({ status: 'running' }), { status: 200, headers: { 'content-type': 'application/json' } })
    throw new Error('unexpected API call')
  }
  try {
    const agent = new LocalAgent(new Workspace(root), 'token-never-printed', { SWICO_API_BASE_URL: 'https://api.example.test', SWICO_CLI_JOURNAL_FILE: journal }, 'approval-required')
    const action = { protocol_version: 1, action_id: 'list-action', action_type: 'list_files', payload: { limit: 10 } }
    const first = await agent.execute('run-1', action, async () => true)
    assert.equal(first.status, 'succeeded')
    assert.deepEqual(first.result, ['journal.jsonl', 'src/main.ts'])
    const callsAfterFirst = calls.length
    const replay = await agent.execute('run-1', action, async () => true)
    assert.equal(replay.status, 'succeeded')
    assert.match(String(replay.result), /already recorded/)
    assert.equal(calls.length, callsAfterFirst)
    assert.doesNotMatch(await readFile(journal, 'utf8'), /token-never-printed/)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('read-only LocalAgent blocks the actual mutation path before server admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-agent-ro-'))
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('{}') }
  try {
    const agent = new LocalAgent(new Workspace(root), 'token', { SWICO_API_BASE_URL: 'https://api.example.test', SWICO_CLI_JOURNAL_FILE: join(root, 'journal.jsonl') }, 'read-only')
    const result = await agent.execute('run-1', { protocol_version: 1, action_id: 'patch-action', action_type: 'create_file', payload: { path: 'new.txt', content: 'blocked' } }, async () => true)
    assert.equal(result.status, 'failed')
    assert.match(String(result.result), /read-only/)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})
