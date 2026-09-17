import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compactLocalSession, findLocalSession, forkLocalSession, listLocalSessions, saveLocalSession, sessionScope, updateLocalSession } from '../dist/local_sessions.js'

const base = (scope) => ({ id: 'session-1', workspace_root: '/workspace/one', workspace_key: scope.workspace_key, account_key: scope.account_key, title: 'Fixture', tier: 'lite', mode: 'agent', task: 'repair fixture', plan: [], actions: [{ action_id: 'action-1', payload_hash: 'hash', status: 'succeeded' }], updated_at: new Date().toISOString() })

test('local sessions are account/workspace scoped and forks do not copy executable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-sessions-')), file = join(root, 'sessions.json'), workspace = join(root, 'workspace')
  try {
    const env = { ...process.env, SWICO_CLI_SESSIONS_FILE: file }, owner = sessionScope('owner@example.test', workspace), other = sessionScope('other@example.test', workspace)
    await saveLocalSession(base(owner), env)
    assert.equal((await listLocalSessions(owner, env)).length, 1)
    assert.equal((await listLocalSessions(other, env)).length, 0)
    assert.equal(await findLocalSession('session-1', other, env), null)
    const fork = await forkLocalSession('session-1', owner, env)
    assert.equal(fork.parent_id, 'session-1'); assert.equal(fork.run_id, undefined); assert.deepEqual(fork.actions, [])
    await updateLocalSession(fork.id, owner, { title: 'Renamed' }, env)
    const compacted = await compactLocalSession('session-1', owner, env)
    assert.match(compacted.compaction.summary, /Pending executable approvals/)
    assert.match(await readFile(file, 'utf8'), /Renamed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
