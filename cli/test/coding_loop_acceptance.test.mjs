import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgent } from '../dist/agent.js'
import { discoverRepository, loadRepositoryInstructions } from '../dist/repository.js'
import { Workspace } from '../dist/workspace.js'

const run = promisify(execFile)

function testSandbox(root) {
  return {
    status: () => ({ implementation: 'test', available: true, reason: 'deterministic acceptance adapter', policy: 'workspace-write', network: 'disabled', writable_roots: [root], filesystem_isolation: 'proven', network_isolation: 'proven', environment_isolation: 'proven', process_isolation: 'proven', supported_policies: ['read-only', 'workspace-write'] }),
    spawn: (argv, options) => spawn(argv[0], argv.slice(1), { ...options, policy: undefined, network: undefined }),
  }
}

async function disposableRepository() {
  const root = await mkdtemp(join(tmpdir(), 'swico-coding-loop-'))
  await run('git', ['init', '-q', root])
  await run('git', ['config', 'user.email', 'swico-fixture@example.invalid'], { cwd: root })
  await run('git', ['config', 'user.name', 'Swico Fixture'], { cwd: root })
  await writeFile(join(root, 'status.txt'), 'fail\n')
  await writeFile(join(root, 'AGENTS.md'), 'Use only the fixture files and keep changes bounded.\n')
  await run('git', ['add', 'status.txt', 'AGENTS.md'], { cwd: root })
  await run('git', ['commit', '-qm', 'fixture'], { cwd: root })
  return root
}

function fakeAgentApi(calls) {
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    const body = init.body ? JSON.parse(String(init.body)) : {}
    calls.push({ path, body })
    if (path.endsWith('/actions')) return new Response(JSON.stringify({ action_id: body.action_id, status: 'accepted' }), { status: 200 })
    if (path.endsWith('/result')) return new Response(JSON.stringify({ status: 'running' }), { status: 200 })
    throw new Error(`unexpected fake API path: ${path}`)
  }
}

test('disposable coding loop discovers, plans, edits, observes failure, repairs, and settles once', async () => {
  const root = await disposableRepository()
  const originalFetch = globalThis.fetch
  const calls = []
  try {
    const metadata = await discoverRepository(root)
    const instructions = await loadRepositoryInstructions(metadata, root)
    assert.deepEqual(instructions.files, ['AGENTS.md'])
    assert.equal(metadata.dirty, false)
    const journal = join(root, '.swico-journal.jsonl')
    globalThis.fetch = fakeAgentApi(calls)
    const workspace = new Workspace(root, testSandbox(root), 'workspace-write', true)
    const agent = new LocalAgent(workspace, 'fixture-token', { SWICO_API_BASE_URL: 'https://api.example.test', SWICO_CLI_JOURNAL_FILE: journal }, 'approval-required')

    const read = await agent.execute('run-fixture', { protocol_version: 1, action_id: 'read-status', action_type: 'read_file', payload: { path: 'status.txt' } }, async () => true)
    assert.equal(read.status, 'succeeded')
    const initial = await workspace.readFile('status.txt')
    const edit = { protocol_version: 1, action_id: 'repair-status', action_type: 'apply_patch', payload: { path: 'status.txt', expected_sha256: initial.sha256, content: 'fail\n' } }
    const denied = await agent.execute('run-fixture', edit, async () => false)
    assert.equal(denied.status, 'failed')
    assert.equal((await workspace.readFile('status.txt')).text, 'fail\n')

    const failing = await agent.execute('run-fixture', { protocol_version: 1, action_id: 'run-test-fail', action_type: 'run_command', payload: { argv: [process.execPath, '-e', "process.exit(require('fs').readFileSync('status.txt','utf8').trim() === 'pass' ? 0 : 1)"], timeout_ms: 5_000, network: 'disabled' } }, async () => true)
    assert.equal(failing.status, 'succeeded')
    assert.equal(failing.result.code, 1)
    const repairBase = await workspace.readFile('status.txt')
    const repaired = await agent.execute('run-fixture', { protocol_version: 1, action_id: 'repair-status', action_type: 'apply_patch', payload: { path: 'status.txt', expected_sha256: repairBase.sha256, content: 'pass\n' } }, async () => true)
    assert.equal(repaired.status, 'succeeded')
    const passingAction = { protocol_version: 1, action_id: 'run-test-pass', action_type: 'run_command', payload: { argv: [process.execPath, '-e', "process.exit(require('fs').readFileSync('status.txt','utf8').trim() === 'pass' ? 0 : 1)"], timeout_ms: 5_000, network: 'disabled' } }
    const passing = await agent.execute('run-fixture', passingAction, async () => true)
    assert.equal(passing.status, 'succeeded')
    const status = await workspace.gitStatus(), diff = await workspace.gitDiff()
    assert.equal(status.dirty, true)
    assert.match(diff, /\+pass/)

    const beforeReplayCalls = calls.length
    const replay = await agent.execute('run-fixture', passingAction, async () => true)
    assert.equal(replay.status, 'succeeded')
    assert.match(String(replay.result), /already recorded/)
    assert.equal(calls.length, beforeReplayCalls)
    assert.equal(calls.filter(item => item.path.endsWith('/actions')).length, 5)
    assert.equal(calls.filter(item => item.path.endsWith('/result')).length, 5)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('coding loop rejects stale edits and symlink escapes without changing the fixture', async () => {
  const root = await disposableRepository()
  const outside = await mkdtemp(join(tmpdir(), 'swico-coding-loop-outside-'))
  try {
    const workspace = new Workspace(root, testSandbox(root), 'workspace-write', true)
    await writeFile(join(outside, 'secret.txt'), 'fixture secret\n')
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    await assert.rejects(() => workspace.readFile('escape.txt'), /Symlinked paths are not allowed|outside/)
    const current = await workspace.readFile('status.txt')
    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeAgentApi([])
    try {
      const agent = new LocalAgent(workspace, 'fixture-token', { SWICO_API_BASE_URL: 'https://api.example.test', SWICO_CLI_JOURNAL_FILE: join(root, 'journal.jsonl') }, 'approval-required')
      const stale = await agent.execute('run-fixture', { protocol_version: 1, action_id: 'stale-edit', action_type: 'apply_patch', payload: { path: 'status.txt', expected_sha256: '0'.repeat(64), content: 'tampered\n' } }, async () => true)
      assert.equal(stale.status, 'failed')
      assert.equal((await workspace.readFile('status.txt')).sha256, current.sha256)
    } finally { globalThis.fetch = originalFetch }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
