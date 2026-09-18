import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../dist/configuration.js'
import { classifyLinuxNamespaceFailure, classifyMacDiagnosticResult, createSandboxAdapter, diagnoseMacSandbox, linuxBubblewrapArgs, linuxBubblewrapReadinessArgs, linuxNamespaceDiagnostics, linuxSystemRuntimeBinds, macRuntimeDiagnostic, runSandboxProbe, verifySandbox } from '../dist/sandbox.js'
import { WorktreeManager } from '../dist/worktrees.js'
import { MutatingWorkerCoordinator } from '../dist/multi_agent.js'
import { loadPermissionProfile, savePermissionProfile } from '../dist/permissions.js'
import { Workspace } from '../dist/workspace.js'
import { readInstalledAgentEvidence, releaseReadiness, validPackageLicense } from '../dist/release_readiness.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { loginMcpOAuth, logoutMcpOAuth, mcpAuthorizationHeader, mcpOAuthStatus } from '../dist/mcp_oauth.js'

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

test('MCP OAuth rejects private non-loopback destinations before discovery', async () => {
  await assert.rejects(() => loginMcpOAuth('https://169.254.169.254/mcp', 'swico-test'), /private or link-local/)
})

test('MCP OAuth completes a local authorization-code lifecycle with refresh, binding, and revocation', async () => {
  const server = createServer()
  let refreshes = 0
  let expectedChallenge = ''
  server.on('request', async (request, response) => {
    if (request.url === '/.well-known/oauth-authorization-server') {
      const origin = `http://127.0.0.1:${(server.address()).port}`
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, revocation_endpoint: `${origin}/revoke`, code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'] }))
      return
    }
    if (request.url === '/mcp') {
      const authorized = request.headers.authorization === `Bearer refreshed-token`
      response.statusCode = authorized ? 200 : 401
      response.end(JSON.stringify({ ok: authorized }))
      return
    }
    if (request.url === '/token' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk
      const values = new URLSearchParams(body)
      if (values.get('grant_type') === 'authorization_code') {
        const expected = createHash('sha256').update(values.get('code_verifier') ?? '').digest('base64url')
        assert.equal(expected, expectedChallenge)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ access_token: 'initial-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 300, scope: 'mcp' }))
      } else if (values.get('grant_type') === 'refresh_token') {
        refreshes += 1; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ access_token: 'refreshed-token', refresh_token: 'refresh-token-rotated', token_type: 'Bearer', expires_in: 300, scope: 'mcp' }))
      } else { response.statusCode = 400; response.end('bad grant') }
      return
    }
    if (request.url === '/revoke' && request.method === 'POST') { response.statusCode = 200; response.end('{}'); return }
    response.statusCode = 404; response.end('not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, store = join(await mkdtemp(join(tmpdir(), 'swico-mcp-oauth-')), 'token')
  const env = { ...process.env, SWICO_CLI_MCP_TOKEN_FILE: store }
  let authUrl = ''
  try {
    const login = loginMcpOAuth(origin, 'swico-test-client', 'mcp', env, line => { authUrl = line.split('\n').at(-1)?.trim() ?? '' })
    for (let attempt = 0; attempt < 100 && !authUrl; attempt += 1) await new Promise(resolve => setImmediate(resolve))
    assert.ok(authUrl)
    const authorization = new URL(authUrl)
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    expectedChallenge = authorization.searchParams.get('code_challenge') ?? ''
    assert.ok(expectedChallenge)
    // The fake authorization endpoint returns the callback code; the real
    // token exchange must still prove the generated PKCE verifier.
    const callback = new URL(authorization.searchParams.get('redirect_uri'))
    callback.searchParams.set('state', authorization.searchParams.get('state'))
    callback.searchParams.set('code', 'test-code')
    await fetch(callback)
    await login
    assert.deepEqual(await mcpOAuthStatus(origin, env), { configured: true, expires_at: (await mcpOAuthStatus(origin, env)).expires_at, issuer: origin })
    const tokenPath = `${store}.${createHash('sha256').update(origin).digest('hex').slice(0, 32)}`
    const saved = JSON.parse(await readFile(tokenPath, 'utf8')); saved.expires_at = 0; await writeFile(tokenPath, JSON.stringify(saved))
    assert.equal(await mcpAuthorizationHeader(origin, env), 'Bearer refreshed-token')
    assert.equal(refreshes, 1)
    const request = await fetch(`${origin}/mcp`, { headers: { authorization: await mcpAuthorizationHeader(origin, env) } })
    assert.equal(request.status, 200)
    assert.equal(await mcpAuthorizationHeader('http://127.0.0.1:1', env), undefined)
    await logoutMcpOAuth(origin, env)
    assert.deepEqual(await mcpOAuthStatus(origin, env), { configured: false })
  } finally { await new Promise(resolve => server.close(resolve)); }
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

test('Linux namespace diagnostics are bounded and never treated as native proof', () => {
  const diagnostics = linuxNamespaceDiagnostics()
  assert.deepEqual(Object.keys(diagnostics), ['unprivileged_userns_clone', 'max_user_namespaces', 'apparmor_restrict_unprivileged_userns'])
  assert.ok(Object.values(diagnostics).every(value => value.length <= 64))
})

test('Linux AppArmor loopback namespace failure has an actionable classification', () => {
  assert.equal(classifyLinuxNamespaceFailure('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted', {
    unprivileged_userns_clone: '1', max_user_namespaces: '28633', apparmor_restrict_unprivileged_userns: '1',
  }), 'ubuntu_apparmor_userns_restricted')
  assert.equal(classifyLinuxNamespaceFailure('bwrap: Creating new namespace failed: Operation not permitted', {
    unprivileged_userns_clone: '0', max_user_namespaces: '28633', apparmor_restrict_unprivileged_userns: 'unavailable',
  }), 'linux_userns_restricted')
})

test('bubblewrap readiness and execution share existence-aware dynamic runtime mounts', () => {
  const binds = linuxSystemRuntimeBinds()
  const readiness = linuxBubblewrapReadinessArgs()
  for (const path of ['/usr', '/lib', '/lib64']) {
    if (!existsSync(path)) continue
    assert.ok(binds.some(bind => bind.source === path && bind.target === path), `${path} should be mounted when present`)
    const index = readiness.indexOf(path)
    assert.notEqual(index, -1, `${path} should be present in readiness args`)
  }
  const execution = linuxBubblewrapArgs(process.cwd(), ['/usr/bin/true'])
  for (const bind of binds) {
    assert.ok(execution.includes(bind.source), `${bind.source} should be present in execution args`)
    assert.ok(execution.includes(bind.target), `${bind.target} should be present in execution args`)
  }
  assert.ok(readiness.includes('--unshare-net'))
  assert.equal(readiness.at(-1), '/usr/bin/true')
})

test('sandbox readiness exposes why a platform is unavailable instead of claiming enforcement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-diagnostic-'))
  try {
    const status = createSandboxAdapter(root).status()
    assert.ok(['ready', 'binary_missing', 'profile_rejected', 'sandbox_apply_denied', 'namespace_unavailable', 'ubuntu_apparmor_userns_restricted', 'linux_userns_restricted', 'unsupported_platform', 'runtime_startup_failure', 'unknown_failure'].includes(status.diagnostic))
    if (!status.available) assert.notEqual(status.diagnostic, 'ready')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('macOS diagnostic does not turn a valid-profile crash into sandbox_apply denial', () => {
  const diagnostic = macRuntimeDiagnostic((_command, args) => {
    if (args[1] === '(version 1') throw Object.assign(new Error('syntax error in malformed control'), { stderr: 'syntax error in malformed control' })
    throw Object.assign(new Error('killed'), { signal: 'SIGKILL' })
  })
  assert.equal(diagnostic.ready, false)
  assert.equal(diagnostic.diagnostic, 'unknown_failure')
})

test('macOS progressive diagnostic classifies deny-default child denial as policy evidence', () => {
  const result = { status: 71, signal: null, stderr: "sandbox-exec: execvp() of '/usr/bin/true' failed: Operation not permitted", stdout: '' }
  assert.equal(classifyMacDiagnosticResult(result, 'policy_deny'), 'policy_denied_expected')
  assert.notEqual(classifyMacDiagnosticResult(result, 'policy_deny'), 'host_sandbox_apply_denied')
})

test('macOS progressive diagnostic separates host sandbox application denial', () => {
  const result = { status: 71, signal: null, stderr: 'sandbox_apply: Operation not permitted', stdout: '' }
  assert.equal(classifyMacDiagnosticResult(result, 'profile_apply'), 'host_sandbox_apply_denied')
})

test('macOS progressive diagnostic reports runtime abort separately from host denial', () => {
  const result = { status: null, signal: 'SIGABRT', stderr: '', stdout: '' }
  assert.equal(classifyMacDiagnosticResult(result, 'profile_apply'), 'sandbox_abort')
})

test('installed runtime exposes a fail-closed macOS diagnostic on unsupported platforms', () => {
  const diagnostic = diagnoseMacSandbox('linux')
  assert.equal(diagnostic.platform, 'linux')
  assert.equal(diagnostic.native_ready, false)
  assert.equal(diagnostic.binary_exists, false)
  assert.deepEqual(diagnostic.stages, [])
})

test('sandbox verify uses real hostile probes and never turns runtime detection into a proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-verify-'))
  try {
    const report = await verifySandbox(root)
    assert.equal(report.runtime.architecture, process.arch)
    assert.equal(report.probes.length, 10)
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

test('sandbox verification treats a crashed or malformed probe as an error, not a deny pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-invalid-probe-'))
  try {
    const adapter = {
      spawn: () => spawn(process.execPath, ['-e', 'process.exit(7)']),
    }
    const probe = await runSandboxProbe(adapter, root, 'outside_workspace_read', 'deny', { workspace: join(root, 'workspace.txt'), outside: join(root, 'outside.txt'), homeSecret: join(root, 'secret.txt'), link: join(root, 'link'), port: 0 }, 'read-only')
    assert.equal(probe.passed, false)
    assert.equal(probe.observed, 'error')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sandbox verification rejects a missing deny fixture and an unavailable network control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-missing-fixture-'))
  try {
    const adapter = { spawn: (argv, options) => spawn(argv[0], argv.slice(1), options) }
    const paths = { workspace: join(root, 'workspace.txt'), outside: join(root, 'missing-outside.txt'), homeSecret: join(root, 'missing-home.txt'), link: join(root, 'missing-link'), port: 0 }
    const probe = await runSandboxProbe(adapter, root, 'outside_workspace_read', 'deny', paths, 'read-only')
    assert.equal(probe.passed, false)
    assert.equal(probe.observed, 'error')
    assert.match(probe.detail, /fixture_missing/)
    const network = await runSandboxProbe(adapter, root, 'network_outbound', 'deny', paths, 'read-only')
    assert.equal(network.passed, false)
    assert.equal(network.observed, 'error')
    assert.match(network.detail, /test_server_unavailable/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sandbox verification does not treat a nested operation failure as child denial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-child-result-'))
  const outside = await mkdtemp(join(tmpdir(), 'swico-stage3-child-outside-'))
  try {
    const fixture = join(outside, 'known.txt')
    await writeFile(fixture, 'known fixture\n')
    const adapter = { spawn: (argv, options) => spawn(argv[0], argv.slice(1), options) }
    const probe = await runSandboxProbe(adapter, root, 'child_process', 'deny', { workspace: join(root, 'workspace.txt'), outside: fixture, homeSecret: join(root, 'secret.txt'), link: join(root, 'link'), port: 0, fixturesKnown: true }, 'read-only')
    assert.equal(probe.observed, 'allowed')
    assert.equal(probe.passed, false)
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('sandbox verification does not treat a closed nonzero port as network enforcement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-network-control-'))
  try {
    const adapter = { status: () => ({ implementation: 'unavailable' }), spawn: (argv, options) => spawn(argv[0], argv.slice(1), options) }
    const probe = await runSandboxProbe(adapter, root, 'network_outbound', 'deny', { workspace: join(root, 'workspace.txt'), outside: join(root, 'outside.txt'), homeSecret: join(root, 'secret.txt'), link: join(root, 'link'), port: 9, controlServerLive: false, fixturesKnown: false }, 'read-only')
    assert.equal(probe.passed, false)
    assert.equal(probe.observed, 'error')
    assert.match(probe.detail, /network_control_refused|test_server_unavailable/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('release readiness reports sandbox proof as a required local-agent gate without network calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-readiness-'))
  try {
    const report = await releaseReadiness(root)
    assert.equal(report.checks.chat_ready, 'unverified')
    assert.equal(report.checks.cloud_ready, 'disabled-optional')
    assert.ok(report.agent_blockers.some(item => /sandbox/i.test(item)))
    assert.ok(report.required_blockers.every(item => !/sandbox/i.test(item)))
    assert.equal(report.checks.agent_sandbox_ready, report.sandbox.verified ? 'ready' : 'blocked')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('installed-agent evidence is strict, current-package bound, and cannot by itself bypass sandbox proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-agent-evidence-'))
  const evidence = join(root, 'evidence.json')
  try {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const valid = {
      schema_version: 1, status: 'passed', package: packageJson.name, version: packageJson.version,
      artifact_sha256: 'a'.repeat(64), platform: process.platform, architecture: process.arch,
      installed_launcher: true, sandbox_verified: true, hostile_probes_passed: true,
      scenario: 'installed-agent-coding-loop', action_count: 6, result_count: 6, settlement_count: 1,
      final_diff_sha256: 'b'.repeat(64), completed_at: new Date().toISOString(),
    }
    await writeFile(evidence, JSON.stringify(valid))
    assert.equal((await readInstalledAgentEvidence({ SWICO_CLI_AGENT_E2E_EVIDENCE: evidence })).state, 'ready')
    await writeFile(evidence, JSON.stringify({ ...valid, version: '0.0.0' }))
    assert.equal((await readInstalledAgentEvidence({ SWICO_CLI_AGENT_E2E_EVIDENCE: evidence })).state, 'unverified')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('release licensing gate rejects arbitrary strings and accepts only bounded SPDX/reference forms', () => {
  assert.equal(validPackageLicense('not-an-owner-decision'), false)
  assert.equal(validPackageLicense('MIT OR Apache-2.0'), true)
  assert.equal(validPackageLicense('SEE LICENSE IN LICENSE'), true)
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
    await run('git', ['init', '-q', root]); await run('git', ['config', 'core.autocrlf', 'false'], { cwd: root }); await run('git', ['config', 'core.eol', 'lf'], { cwd: root }); await run('git', ['config', 'user.email', 'swico-test@example.invalid'], { cwd: root }); await run('git', ['config', 'user.name', 'Swico Test'], { cwd: root })
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

test('workspace-write is persisted and mutating workers stay reviewable in separate worktrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-worker-')), stateRoot = await mkdtemp(join(tmpdir(), 'swico-worker-state-'))
  try {
    await run('git', ['init', '-q', root]); await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-C', root, 'commit', '--allow-empty', '-m', 'init'])
    const preferences = join(stateRoot, 'preferences.json'), env = { ...process.env, SWICO_CLI_PREFERENCES_FILE: preferences, SWICO_CLI_WORKTREE_ROOT: join(stateRoot, 'workers'), SWICO_CLI_WORKTREES_FILE: join(stateRoot, 'worktrees.json'), SWICO_CLI_WORKERS_FILE: join(stateRoot, 'workers.json') }
    await savePermissionProfile('workspace-write', env)
    assert.equal(await loadPermissionProfile(env), 'workspace-write')
    const metadata = { root, gitAvailable: true, head: (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim(), branch: 'master', dirty: false, staged: [], unstaged: [], untracked: [] }
    const coordinator = new MutatingWorkerCoordinator(metadata, env, 1), worker = await coordinator.start('repair fixture')
    assert.notEqual(worker.worktree.path, root)
    await writeFile(join(worker.worktree.path, 'changed.txt'), 'review me\n')
    const completed = await coordinator.complete(worker.id)
    assert.equal(completed.status, 'completed'); assert.match(completed.diff, /changed\.txt/)
    assert.equal((await run('git', ['-C', root, 'status', '--porcelain'])).stdout.trim(), '')
    const restored = new MutatingWorkerCoordinator(metadata, env, 1).list().find(item => item.id === worker.id)
    assert.equal(restored?.status, 'completed'); assert.equal(restored?.diff_hash, completed.diff_hash)
    await coordinator.discard(worker.id, async () => true)
  } finally { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }) }
})

test('separate CLI processes serialize worker admission through the durable lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-worker-race-')), stateRoot = await mkdtemp(join(tmpdir(), 'swico-worker-race-state-'))
  try {
    await run('git', ['init', '-q', root]); await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-C', root, 'commit', '--allow-empty', '-m', 'init'])
    const env = { ...process.env, SWICO_CLI_WORKERS_FILE: join(stateRoot, 'workers.json'), SWICO_CLI_WORKTREE_ROOT: join(stateRoot, 'worktrees') }
    const modulePath = join(process.cwd(), 'dist/multi_agent.js')
    const moduleUrl = pathToFileURL(modulePath).href
    const code = `import { execFileSync } from 'node:child_process'; import { MutatingWorkerCoordinator } from ${JSON.stringify(moduleUrl)}; const root=process.env.TEST_ROOT; const childEnv={...process.env,SWICO_CLI_WORKERS_FILE:${JSON.stringify(join(stateRoot, 'workers.json'))},SWICO_CLI_WORKTREES_FILE:${JSON.stringify(join(stateRoot, 'worktrees.json'))},SWICO_CLI_WORKTREE_ROOT:${JSON.stringify(join(stateRoot, 'worktrees'))}}; const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(); const metadata={root,gitAvailable:true,head,branch:'master',dirty:false,staged:[],unstaged:[],untracked:[]}; try { await new MutatingWorkerCoordinator(metadata,childEnv,1).start('concurrent fixture'); console.log('admitted'); } catch (error) { console.error(error.message); process.exitCode=2 }`
    const launch = () => new Promise(resolve => { const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...env, TEST_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; child.stdout.on('data', value => { out += value }); child.stderr.on('data', value => { err += value }); child.on('close', status => resolve({ status, out, err })) })
    const results = await Promise.all([launch(), launch()])
    assert.equal(results.filter(item => item.status === 0).length, 1, JSON.stringify(results))
    assert.equal(results.filter(item => item.status === 2).length, 1)
    const saved = JSON.parse(await readFile(join(stateRoot, 'workers.json'), 'utf8'))
    assert.equal(saved.filter(item => item.worktree?.repository_identity === root && item.status === 'active').length, 1)
  } finally { await rm(root, { recursive: true, force: true }); await rm(stateRoot, { recursive: true, force: true }) }
})

test('non-interactive worktree cleanup fails closed before touching an owned worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-stage3-clean-'))
  const state = join(root, 'state.json'), worktreeRoot = join(root, 'worktrees')
  try {
    await run('git', ['init', '-q', root]); await run('git', ['config', 'core.autocrlf', 'false'], { cwd: root }); await run('git', ['config', 'core.eol', 'lf'], { cwd: root }); await run('git', ['config', 'user.email', 'swico-test@example.invalid'], { cwd: root }); await run('git', ['config', 'user.name', 'Swico Test'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'base\n'); await run('git', ['add', 'tracked.txt'], { cwd: root }); await run('git', ['commit', '-qm', 'base'], { cwd: root })
    const metadata = { root, gitAvailable: true, head: (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), branch: 'master', dirty: false, staged: [], unstaged: [], untracked: [] }
    const manager = new WorktreeManager(metadata, { SWICO_CLI_WORKTREES_FILE: state, SWICO_CLI_WORKTREE_ROOT: worktreeRoot }), item = await manager.create('run-2')
    const result = await run(process.execPath, [join(process.cwd(), 'dist/cli.js'), 'worktree', 'clean', item.id], { cwd: root, env: { ...process.env, SWICO_CLI_WORKTREES_FILE: state, SWICO_CLI_WORKTREE_ROOT: worktreeRoot } }).then(() => null, error => error)
    assert.match(String(result?.stderr ?? result?.message), /interactive terminal and explicit approval/)
    assert.equal((await manager.list()).length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
