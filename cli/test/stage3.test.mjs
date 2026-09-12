import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../dist/configuration.js'
import { createSandboxAdapter } from '../dist/sandbox.js'
import { WorktreeManager } from '../dist/worktrees.js'
import { Workspace } from '../dist/workspace.js'
import { spawn } from 'node:child_process'

const run = promisify(execFile)

test('project configuration cannot elevate sandbox or approval policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-config-'))
  try {
    await run('git', ['init', '-q', root])
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, '.swico'), { recursive: true }))
    await writeFile(join(root, '.swico', 'config.toml'), 'sandbox_policy = "workspace-write"\napproval_policy = "on-request"\n')
    const loaded = await loadConfig(root, { XDG_CONFIG_HOME: join(root, 'user-config') })
    assert.equal(loaded.project?.sandboxPolicy, 'read-only')
    assert.equal(loaded.project?.approvalPolicy, 'always')
    assert.equal(loaded.effective.sandboxPolicy, 'read-only')
    assert.equal(loaded.effective.approvalPolicy, 'always')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sandbox capability detection fails closed when an OS runtime is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-sandbox-'))
  try {
    const status = createSandboxAdapter(root, 'win32').status()
    assert.equal(status.available, false)
    assert.equal(status.implementation, 'unavailable')
    assert.throws(() => createSandboxAdapter(root, 'win32').wrap(['node', '-e', '0']), /Refusing unsandboxed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('workspace commands pass the independent sandbox and network policies to the adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-command-'))
  try {
    let received
    const adapter = {
      status: () => ({ implementation: 'test', available: true, reason: 'injected test runtime', policy: 'workspace-write', network: 'disabled', writable_roots: [root] }),
      wrap: argv => ({ command: argv[0], args: argv.slice(1) }),
      spawn: (argv, options) => { received = options; return spawn(argv[0], argv.slice(1), { ...options, policy: undefined, network: undefined }) },
    }
    const result = await new Workspace(root, adapter, 'read-only').runCommand([process.execPath, '-e', 'process.stdout.write("ok")'], 10_000, async () => true)
    assert.equal(result.stdout, 'ok')
    assert.equal(received.policy, 'read-only')
    assert.equal(received.network, 'disabled')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('explicit Swico worktrees are detached, owned, and do not alter a dirty primary tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-worktree-'))
  const state = join(root, 'state.json'), worktreeRoot = join(root, 'worktrees')
  try {
    await run('git', ['init', '-q', root]); await run('git', ['config', 'user.email', 'swico-test@example.invalid'], { cwd: root }); await run('git', ['config', 'user.name', 'Swico Test'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'base\n'); await run('git', ['add', 'tracked.txt'], { cwd: root }); await run('git', ['commit', '-qm', 'base'], { cwd: root })
    await writeFile(join(root, 'uncommitted.txt'), 'preserve\n')
    const metadata = { root, gitAvailable: true, head: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), branch: 'master', dirty: true, staged: [], unstaged: ['uncommitted.txt'], untracked: ['uncommitted.txt'] }
    const manager = new WorktreeManager(metadata, { SWICO_CLI_WORKTREES_FILE: state, SWICO_CLI_WORKTREE_ROOT: worktreeRoot })
    const item = await manager.create('run-1')
    assert.equal(await readFile(join(root, 'uncommitted.txt'), 'utf8'), 'preserve\n')
    assert.equal(await readFile(join(item.path, 'tracked.txt'), 'utf8'), 'base\n')
    assert.equal((await manager.list()).length, 1)
    await manager.clean(item.id, async () => true)
    assert.equal((await manager.list()).length, 0)
    assert.equal(await readFile(join(root, 'uncommitted.txt'), 'utf8'), 'preserve\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})
