import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../dist/configuration.js'
import { createSandboxAdapter, verifySandbox } from '../dist/sandbox.js'
import { WorktreeManager } from '../dist/worktrees.js'
import { Workspace } from '../dist/workspace.js'
import { releaseReadiness } from '../dist/release_readiness.js'
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

test('project search configuration can narrow but never elevate network or billing behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-search-policy-'))
  try {
    await run('git', ['init', '-q', root])
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, '.swico'), { recursive: true }))
    await writeFile(join(root, '.swico', 'config.toml'), 'search_mode = "on"\n')
    assert.equal((await loadConfig(root, { SWICO_CLI_CONFIG_FILE: join(root, 'missing-user.toml') })).effective.searchMode, 'auto')
    await writeFile(join(root, 'user-off.toml'), 'search_mode = "off"\n')
    assert.equal((await loadConfig(root, { SWICO_CLI_CONFIG_FILE: join(root, 'user-off.toml') })).effective.searchMode, 'off')
    await writeFile(join(root, 'user-on.toml'), 'search_mode = "on"\n')
    assert.equal((await loadConfig(root, { SWICO_CLI_CONFIG_FILE: join(root, 'user-on.toml') })).effective.searchMode, 'on')
    await writeFile(join(root, '.swico', 'config.toml'), 'search_mode = "auto"\n')
    assert.equal((await loadConfig(root, { SWICO_CLI_CONFIG_FILE: join(root, 'user-on.toml') })).effective.searchMode, 'auto')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sandbox capability detection fails closed when an OS runtime is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-sandbox-'))
  try {
    const status = createSandboxAdapter(root, 'win32').status()
    assert.equal(status.available, false)
    assert.equal(status.implementation, 'unavailable')
    assert.equal(status.diagnostic, 'unsupported_platform')
    assert.throws(() => createSandboxAdapter(root, 'win32').wrap(['node', '-e', '0']), /Refusing unsandboxed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sandbox readiness exposes why a platform is unavailable instead of claiming enforcement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-diagnostic-'))
  try {
    const status = createSandboxAdapter(root).status()
    assert.ok(['ready', 'binary_missing', 'profile_rejected', 'sandbox_apply_denied', 'namespace_unavailable', 'unsupported_platform'].includes(status.diagnostic))
    if (!status.available) assert.notEqual(status.diagnostic, 'ready')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sandbox verify uses real hostile probes and never turns runtime detection into a proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-verify-'))
  try {
    const report = await verifySandbox(root)
    assert.equal(report.runtime.architecture, process.arch)
    assert.equal(report.probes.length, 9)
    assert.ok(report.probes.every(item => item.name && item.detail))
    if (createSandboxAdapter(root).status().available) {
      assert.equal(report.verified, true)
      assert.ok(report.probes.every(item => item.passed))
    } else {
      assert.equal(report.verified, false)
      assert.ok(report.probes.every(item => item.observed === 'not_run'))
    }
    assert.doesNotMatch(JSON.stringify(report), /fake verification secret|SWICO_VERIFY_SECRET/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('release readiness reports sandbox proof as a required local-agent gate without network calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-readiness-'))
  try {
    const report = await releaseReadiness(root)
    assert.equal(report.checks.chat_ready, 'ready')
    assert.equal(report.checks.cloud_ready, 'disabled-optional')
    assert.ok(report.required_blockers.some(item => /sandbox/i.test(item)))
    assert.equal(report.checks.agent_sandbox_ready, report.sandbox.verified ? 'ready' : 'blocked')
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

test('non-interactive worktree cleanup fails closed before touching an owned worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-clean-'))
  const state = join(root, 'state.json'), worktreeRoot = join(root, 'worktrees')
  try {
    await run('git', ['init', '-q', root]); await run('git', ['config', 'user.email', 'swico-test@example.invalid'], { cwd: root }); await run('git', ['config', 'user.name', 'Swico Test'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'base\n'); await run('git', ['add', 'tracked.txt'], { cwd: root }); await run('git', ['commit', '-qm', 'base'], { cwd: root })
    const metadata = { root, gitAvailable: true, head: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), branch: 'master', dirty: false, staged: [], unstaged: [], untracked: [] }
    const manager = new WorktreeManager(metadata, { SWICO_CLI_WORKTREES_FILE: state, SWICO_CLI_WORKTREE_ROOT: worktreeRoot }), item = await manager.create('run-2')
    const result = await run(process.execPath, [join(process.cwd(), 'dist/cli.js'), 'worktree', 'clean', item.id], { cwd: root, env: { ...process.env, SWICO_CLI_WORKTREES_FILE: state, SWICO_CLI_WORKTREE_ROOT: worktreeRoot } }).then(() => null, error => error)
    assert.match(String(result?.stderr ?? result?.message), /interactive terminal and explicit approval/)
    assert.equal((await manager.list()).length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
