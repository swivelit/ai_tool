/*
 * Non-cloud installed-artifact acceptance harness.
 *
 * This is deliberately a developer/CI harness and is not shipped in the npm
 * package. It starts the public launcher from a packed artifact, uses a
 * local HTTP planner fixture, and requires the real Linux sandbox verifier.
 * No provider, billing, or production service is contacted.
 */
import * as pty from 'node-pty'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { windowsShimInvocation } from './windows-launcher.mjs'

const execFileAsync = promisify(execFile)
const packageName = '@swiveltechnologies/swico'
const maxOutput = 256 * 1024

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function bounded(value) { return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(-maxOutput) }
function parseArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function pathIsInside(root, candidate) {
  const result = relative(root, candidate)
  return result === '' || (!result.startsWith('..') && !isAbsolute(result))
}

/**
 * Validate the public npm launcher before giving it to node-pty. Keeping this
 * separate makes broken installs fail with a useful diagnostic instead of the
 * opaque node-pty `execvp(3)` message.
 */
export async function validateInstalledLauncher({ launcher, prefix, expectedVersion, jsTarget }) {
  let launcherStat
  try {
    launcherStat = await lstat(launcher)
  } catch {
    throw new Error(`installed launcher missing: expected ${launcher}`)
  }
  if (!launcherStat.isFile() && !launcherStat.isSymbolicLink()) throw new Error(`installed launcher is not a file or symlink: ${launcher}`)

  let target
  try { target = await realpath(launcher) } catch { throw new Error(`installed launcher has a broken symlink: ${launcher}`) }
  const resolvedPrefix = await realpath(prefix)
  if (!pathIsInside(resolvedPrefix, join(await realpath(dirname(launcher)), basename(launcher)))) throw new Error('installed launcher escapes temporary prefix')
  if (!pathIsInside(resolvedPrefix, target)) throw new Error(`installed launcher escapes temporary prefix: ${target}`)
  // Windows npm installs a .cmd shim, not an executable JavaScript symlink.
  // Validate BOTH the public shim and its declared package target. Never execFile
  // a raw .js file on Windows, and never pretend chmod provides Windows ACLs.
  if (process.platform === 'win32') {
    if (!launcher.toLowerCase().endsWith('.cmd')) throw new Error('installed Windows launcher must be the public .cmd shim')
    const expectedTarget = jsTarget ?? join(prefix, 'node_modules', ...packageName.split('/'), 'dist', 'cli.js')
    try { target = await realpath(expectedTarget) } catch { throw new Error('installed launcher JavaScript target missing') }
    if (!pathIsInside(resolvedPrefix, target)) throw new Error('installed launcher target escapes temporary prefix')
  }
  const targetStat = await lstat(target)
  if (!targetStat.isFile()) throw new Error(`installed launcher target is not a file: ${target}`)
  if (process.platform !== 'win32' && (targetStat.mode & 0o111) === 0) throw new Error(`installed launcher is not executable: ${target}`)
  const source = await readFile(target, 'utf8')
  if (!source.startsWith('#!/usr/bin/env node')) throw new Error(`installed launcher target has an unexpected shebang: ${target}`)

  const commandEnv = { ...process.env, SWICO_CLI_CONFIG_FILE: join(prefix, 'missing-user.toml') }
  const invoke = args => {
    const call = process.platform === 'win32' ? windowsShimInvocation(launcher, args) : { command: launcher, args, options: {} }
    return run(call.command, call.args, { ...call.options, cwd: prefix, env: commandEnv, timeout: 10_000 })
  }
  const versionResult = await invoke(['--version'])
  if (versionResult.stdout.trim() !== expectedVersion) throw new Error(`installed launcher version mismatch: expected ${expectedVersion}, got ${versionResult.stdout.trim()}`)
  const helpResult = await invoke(['--help'])
  if (!/Usage:\s+swico/i.test(helpResult.stdout)) throw new Error('installed launcher --help did not identify the Swico CLI')
  return { launcher, target, version: versionResult.stdout.trim(), help_checked: true }
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { windowsHide: true, maxBuffer: maxOutput, ...options })
}

async function fixtureRepository(root) {
  await run('git', ['init', '-q', root])
  await run('git', ['-C', root, 'config', 'user.email', 'swico-installed-fixture@example.invalid'])
  await run('git', ['-C', root, 'config', 'user.name', 'Swico Installed Fixture'])
  await writeFile(join(root, 'main.mjs'), 'export const answer = 1\n')
  await writeFile(join(root, 'test.mjs'), "import assert from 'node:assert/strict'\nimport { answer } from './main.mjs'\nassert.equal(answer, 2)\n")
  await writeFile(join(root, 'AGENTS.md'), 'Only edit main.mjs. Run node test.mjs after edits.\n')
  await run('git', ['-C', root, 'add', 'main.mjs', 'test.mjs', 'AGENTS.md'])
  await run('git', ['-C', root, 'commit', '-qm', 'fixture'])
}

function patch(from, to) {
  return `@@ -1,1 +1,1 @@\n-export const answer = ${from}\n+export const answer = ${to}\n`
}

async function plannerFixture(root) {
  const initial = await readFile(join(root, 'main.mjs'), 'utf8')
  const afterFirst = 'export const answer = 3\n'
  const afterRepair = 'export const answer = 2\n'
  const outside = join(dirname(root), `${basename(root)}-outside-secret.txt`)
  const link = join(root, 'escape.txt')
  await writeFile(outside, 'fixture credential material\n', { mode: 0o600 })
  await symlink(outside, link)
  const networkEscape = join(root, 'network-escape.txt')
  const state = { plans: 0, admissions: [], results: [], complete: 0, cancelled: 0, runId: `fixture-run-${randomUUID()}` }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const bodyText = request.method === 'GET' ? '' : await new Promise(resolveBody => {
      let text = ''
      request.on('data', chunk => { text += chunk.toString(); if (text.length > 64 * 1024) request.destroy() })
      request.on('end', () => resolveBody(text))
    })
    let body = {}
    try { body = bodyText ? JSON.parse(bodyText) : {} } catch { response.writeHead(400); response.end(JSON.stringify({ detail: 'invalid JSON' })); return }
    response.setHeader('content-type', 'application/json')
    const send = (value, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)) }
    if (url.pathname === '/api/cli/v1/health') return send({ cli_enabled: true, agent_enabled: true })
    if (url.pathname === '/network-control') return send({ marker: 'swico-installed-network-control-v1' })
    if (url.pathname === '/api/cli/v1/me') return send({ account: { email: 'installed-fixture@example.invalid', name: 'Installed Fixture' }, tier: 'lite' })
    if (url.pathname === '/api/cli/v1/agent/runs' && request.method === 'POST') return send({ run_id: state.runId, request_id: 'fixture-request', status: 'running', tier: 'lite', max_steps: 20, current_step: 0, expires_at: new Date(Date.now() + 60_000).toISOString() })
    if (url.pathname === `/api/cli/v1/agent/runs/${state.runId}/plan` && request.method === 'POST') {
      const plan = [
        { action_id: 'installed-list', action_type: 'list_files', payload: { limit: 20 } },
        { action_id: 'installed-read', action_type: 'read_file', payload: { path: 'test.mjs' } },
        { action_id: 'installed-unapproved-create', action_type: 'create_file', payload: { path: 'denied.txt', content: 'must not be created\n' } },
        { action_id: 'installed-outside-read', action_type: 'read_file', payload: { path: '../outside-secret.txt' } },
        { action_id: 'installed-outside-write', action_type: 'create_file', payload: { path: '../outside-write.txt', content: 'must not be written\n' } },
        { action_id: 'installed-home-secret', action_type: 'read_file', payload: { path: '.env' } },
        { action_id: 'installed-symlink-escape', action_type: 'read_file', payload: { path: 'escape.txt' } },
        { action_id: 'installed-secret-environment', action_type: 'run_command', payload: { argv: ['node', '-e', 'process.exit(process.env.SWICO_VERIFY_SECRET ? 0 : 1)'], timeout_ms: 10_000, network: 'disabled' } },
        { action_id: 'installed-network-denied', action_type: 'run_command', payload: { argv: ['node', '-e', `const fs=require('node:fs');const http=require('node:http');const r=http.get('http://127.0.0.1:${server.address().port}/network-control',()=>{fs.writeFileSync(${JSON.stringify(networkEscape)},'network escape');process.exit(0)});r.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000)`], timeout_ms: 10_000, network: 'disabled' } },
        { action_id: 'installed-first-edit', action_type: 'apply_patch', payload: { path: 'main.mjs', expected_sha256: sha256(initial), patch: patch(1, 3) } },
        { action_id: 'installed-failing-test', action_type: 'run_command', payload: { argv: ['node', 'test.mjs'], timeout_ms: 10_000, network: 'disabled' } },
        { action_id: 'installed-repair-edit', action_type: 'apply_patch', payload: { path: 'main.mjs', expected_sha256: sha256(afterFirst), patch: patch(3, 2) } },
        { action_id: 'installed-passing-test', action_type: 'run_command', payload: { argv: ['node', 'test.mjs'], timeout_ms: 10_000, network: 'disabled' } },
      ]
      const next = plan[state.plans++]
      return next ? send({ kind: 'action', protocol_version: 1, ...next }) : send({ kind: 'assistant', text: 'The fixture test now passes and the bounded repair is complete.' })
    }
    const actionMatch = url.pathname.match(new RegExp(`^/api/cli/v1/agent/runs/${state.runId}/actions$`))
    if (actionMatch && request.method === 'POST') { state.admissions.push(body); return send({ action_id: body.action_id, status: 'accepted' }) }
    const resultMatch = url.pathname.match(new RegExp(`^/api/cli/v1/agent/runs/${state.runId}/actions/[^/]+/result$`))
    if (resultMatch && request.method === 'POST') { state.results.push(body); return send({ status: 'recorded' }) }
    if (url.pathname === `/api/cli/v1/agent/runs/${state.runId}/complete` && request.method === 'POST') { state.complete += 1; return send({ status: 'completed', settlement_id: 'fixture-settlement-1' }) }
    if (url.pathname === `/api/cli/v1/agent/runs/${state.runId}/cancel` && request.method === 'POST') { state.cancelled += 1; return send({ status: 'cancelled' }) }
    send({ detail: `fixture route not found: ${request.method} ${url.pathname}` }, 404)
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  return { server, state, origin: `http://127.0.0.1:${server.address().port}`, outside, link, networkEscape, expected: { initial, afterFirst, afterRepair } }
}

async function runInstalledLauncher(launcher, fixtureRoot, env, options = {}) {
  const child = pty.spawn(launcher, ['agent', 'Fix the failing test in this disposable repository.'], {
    cwd: fixtureRoot,
    cols: 120,
    rows: 40,
    name: 'xterm-256color',
    env: { ...process.env, ...env, TERM: 'xterm-256color' },
  })
  let output = '', trustSent = false, approvals = 0, denied = false, settled = false
  let cancellationTimer
  const result = await new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); rejectResult(new Error('Installed agent acceptance timed out.')) } }, 90_000)
    child.onData(chunk => {
      output = `${output}${chunk}`.slice(-maxOutput)
      if (!trustSent && /Trust .*send selected repository context/i.test(output)) { trustSent = true; child.write('y\r') }
      const promptCount = (output.match(/Approve\? \(y\/N\)/g) ?? []).length
      while (approvals < promptCount) {
        approvals += 1
        if (options.cancelOnApproval && !cancellationTimer) {
          child.write('y\r')
          cancellationTimer = setTimeout(() => child.write('\u0003'), options.cancelDelayMs ?? 500)
        } else if (!denied && /Create denied\.txt\?/i.test(output)) { denied = true; child.write('n\r') }
        else child.write('y\r')
      }
    })
    child.onExit(event => { clearTimeout(timer); if (cancellationTimer) clearTimeout(cancellationTimer); if (settled) return; settled = true; resolveResult({ code: event.exitCode, signal: event.signal, output }) })
  })
  if (result.code !== 0) throw new Error(`Installed agent exited with ${result.code ?? 'unknown'}: ${bounded(result.output)}`)
  return { ...result, approvals }
}

async function cancellationFixture(root) {
  const pidFile = join(root, 'cancel-child.pid')
  const state = { runId: `cancel-run-${randomUUID()}`, admissions: [], resultAttempts: 0, rejectedResults: 0, cancelled: 0, complete: 0 }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('content-type', 'application/json')
    const send = (value, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)) }
    if (url.pathname === '/api/cli/v1/health') return send({ cli_enabled: true, agent_enabled: true })
    if (url.pathname === '/api/cli/v1/me') return send({ account: { email: 'installed-cancel@example.invalid', name: 'Installed Cancel' }, tier: 'lite' })
    if (url.pathname === '/api/cli/v1/agent/runs' && request.method === 'POST') return send({ run_id: state.runId, request_id: 'cancel-request', status: 'running', tier: 'lite', max_steps: 2, current_step: 0, expires_at: new Date(Date.now() + 60_000).toISOString() })
    if (url.pathname === `/api/cli/v1/agent/runs/${state.runId}/plan` && request.method === 'POST') {
      if (state.admissions.length === 0) return send({ kind: 'action', protocol_version: 1, action_id: 'installed-cancellable-command', action_type: 'run_command', payload: { argv: ['node', '-e', `const fs=require('node:fs');const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], timeout_ms: 20_000, network: 'disabled' } })
      return send({ kind: 'assistant', text: 'Cancellation was observed and no terminal result was accepted.' })
    }
    if (url.pathname === `/api/cli/v1/agent/runs/${state.runId}/actions` && request.method === 'POST') { let body = ''; for await (const chunk of request) body += chunk; state.admissions.push(JSON.parse(body)); return send({ action_id: state.admissions.at(-1).action_id, status: 'accepted' }) }
    if (url.pathname.startsWith(`/api/cli/v1/agent/runs/${state.runId}/actions/`) && url.pathname.endsWith('/result') && request.method === 'POST') { state.resultAttempts += 1; if (state.cancelled > 0) { state.rejectedResults += 1; return send({ detail: 'run is cancelled' }, 409) } return send({ status: 'recorded' }) }
    if (url.pathname === `/api/cli/v1/agent/runs/${state.runId}/cancel` && request.method === 'POST') { state.cancelled += 1; return send({ status: 'cancelled' }) }
    if (url.pathname === `/api/cli/v1/agent/runs/${state.runId}/complete` && request.method === 'POST') { state.complete += 1; return send({ status: 'completed' }) }
    return send({ detail: 'not found' }, 404)
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  return { server, state, pidFile, origin: `http://127.0.0.1:${server.address().port}` }
}

async function unknownOutcomeFixture(root) {
  const mutationFile = join(root, 'mutation-count.log')
  const state = { runCount: 0, planCount: 0, admissions: [], resultAttempts: 0, complete: 0 }
  let firstRunId = ''
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    response.setHeader('content-type', 'application/json')
    const send = (value, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)) }
    if (url.pathname === '/api/cli/v1/health') return send({ cli_enabled: true, agent_enabled: true })
    if (url.pathname === '/api/cli/v1/me') return send({ account: { email: 'installed-unknown@example.invalid', name: 'Installed Unknown' }, tier: 'lite' })
    if (url.pathname === '/api/cli/v1/agent/runs' && request.method === 'POST') { state.runCount += 1; firstRunId = `unknown-run-${state.runCount}`; return send({ run_id: firstRunId, request_id: `unknown-request-${state.runCount}`, status: 'running', tier: 'lite', max_steps: 2, current_step: 0, expires_at: new Date(Date.now() + 60_000).toISOString() }) }
    if (url.pathname === `/api/cli/v1/agent/runs/${firstRunId}/plan` && request.method === 'POST') {
      state.planCount += 1
      return send(state.planCount === 1 || state.planCount === 2 ? { kind: 'action', protocol_version: 1, action_id: 'installed-unknown-mutation', action_type: 'run_command', payload: { argv: ['node', '-e', `require('node:fs').appendFileSync(${JSON.stringify(mutationFile)},'mutation\\n')`], timeout_ms: 10_000, network: 'disabled' } } : { kind: 'assistant', text: 'Reconciliation requires explicit user review.' })
    }
    const actionPath = new RegExp(`^/api/cli/v1/agent/runs/[^/]+/actions$`)
    if (actionPath.test(url.pathname) && request.method === 'POST') { let body = ''; for await (const chunk of request) body += chunk; state.admissions.push(JSON.parse(body)); return send({ action_id: state.admissions.at(-1).action_id, status: 'accepted' }) }
    if (url.pathname.match(/\/actions\/[^/]+\/result$/) && request.method === 'POST') {
      state.resultAttempts += 1
      if (state.resultAttempts === 1) { request.socket.destroy(); return }
      return send({ status: 'recorded' })
    }
    if (url.pathname.endsWith('/complete') && request.method === 'POST') { state.complete += 1; return send({ status: 'completed' }) }
    return send({ detail: 'not found' }, 404)
  })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  return { server, state, mutationFile, origin: `http://127.0.0.1:${server.address().port}` }
}

async function fixtureEnvironment(fixture, state, email) {
  const tokens = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 3_600, session_id: 'fixture-session', tier: 'lite', tier_label: 'Lite', scopes: ['chat', 'agent'], account: { email, name: 'Installed Fixture' } }
  const credentialFile = join(state, `${email.replace(/[^a-z0-9]+/gi, '-')}-credentials.json`)
  await writeFile(credentialFile, JSON.stringify({ endpoint: fixture.origin, tokens }) + '\n', { mode: 0o600 })
  return {
    SWICO_API_BASE_URL: fixture.origin,
    SWICO_CLI_ALLOW_INSECURE_LOCAL: '1',
    SWICO_CLI_CREDENTIAL_FILE: credentialFile,
    SWICO_CLI_JOURNAL_FILE: join(state, `${email.replace(/[^a-z0-9]+/gi, '-')}-journal.jsonl`),
    SWICO_CLI_STATE_DIR: state,
    SWICO_CLI_SESSIONS_FILE: join(state, `${email.replace(/[^a-z0-9]+/gi, '-')}-sessions.json`),
    SWICO_CLI_PROMPT_HISTORY_FILE: join(state, `${email.replace(/[^a-z0-9]+/gi, '-')}-prompt-history.json`),
    SWICO_CLI_WORKERS_FILE: join(state, `${email.replace(/[^a-z0-9]+/gi, '-')}-workers.json`),
    XDG_CONFIG_HOME: state,
    XDG_CACHE_HOME: state,
    SWICO_CLI_CONFIG_FILE: join(state, 'missing-user.toml'),
    SWICO_CLI_WORKSPACE: '',
    SWICO_VERIFY_SECRET: 'fixture-secret-must-not-enter-sandbox',
  }
}

async function assertPidGone(pidFile) {
  const pid = Number((await readFile(pidFile, 'utf8')).trim())
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

async function main() {
  if (process.platform !== 'linux') {
    console.log(JSON.stringify({ status: 'not_run', reason: 'installed native agent acceptance is Linux-only and requires bubblewrap' }))
    process.exitCode = 2
    return
  }
  const artifact = parseArg('--artifact')
  if (!artifact || !existsSync(artifact)) throw new Error('Pass --artifact pointing to the canonical packed Swico CLI tarball.')
  const root = await mkdtemp(join(tmpdir(), 'swico-installed-agent-'))
  const prefix = join(root, 'prefix'), repo = join(root, 'repo'), state = join(root, 'state')
  await mkdir(state, { recursive: true })
  let fixture, cancellation, unknown
  try {
    await mkdir(repo, { recursive: true })
    const artifactPath = resolve(artifact)
    const artifactName = basename(artifactPath)
    const expectedArtifactPrefix = 'swiveltechnologies-swico-'
    if (!artifactName.startsWith(expectedArtifactPrefix) || !artifactName.endsWith('.tgz')) throw new Error(`unexpected Swico artifact filename: ${artifactName}`)
    await run('npm', ['install', '--global', '--ignore-scripts', '--prefix', prefix, artifactPath], { cwd: dirname(artifactPath), env: { ...process.env, npm_config_update_notifier: 'false' } })
    await fixtureRepository(repo)
    fixture = await plannerFixture(repo)
    const installedManifestPath = join(prefix, 'lib', 'node_modules', '@swiveltechnologies', 'swico', 'package.json')
    const installedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8'))
    if (installedManifest.name !== packageName) throw new Error(`installed package name mismatch: ${installedManifest.name}`)
    if (!/^swiveltechnologies-swico-\d+\.\d+\.\d+\.tgz$/.test(artifactName) || !artifactName.includes(`-${installedManifest.version}.tgz`)) throw new Error(`artifact/package version mismatch: ${artifactName} vs ${installedManifest.version}`)
    const artifactHash = sha256(await readFile(artifactPath))
    const launcher = join(prefix, 'bin', 'swico')
    const launcherPreflight = await validateInstalledLauncher({ launcher, prefix, expectedVersion: installedManifest.version })
    const hostControl = await fetch(`${fixture.origin}/network-control`)
    const hostControlBody = await hostControl.json()
    if (!hostControl.ok || hostControlBody.marker !== 'swico-installed-network-control-v1') throw new Error('host network control was not reachable before sandboxed execution')
    const tokens = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 3_600, session_id: 'fixture-session', tier: 'lite', tier_label: 'Lite', scopes: ['chat', 'agent'], account: { email: 'installed-fixture@example.invalid', name: 'Installed Fixture' } }
    const credentialFile = join(state, 'credentials.json')
    await writeFile(credentialFile, JSON.stringify({ endpoint: fixture.origin, tokens }) + '\n', { mode: 0o600 })
    const acceptance = await runInstalledLauncher(launcher, repo, {
      SWICO_API_BASE_URL: fixture.origin,
      SWICO_CLI_ALLOW_INSECURE_LOCAL: '1',
      SWICO_CLI_CREDENTIAL_FILE: credentialFile,
      SWICO_CLI_JOURNAL_FILE: join(state, 'action-journal.jsonl'),
      SWICO_CLI_STATE_DIR: state,
      SWICO_CLI_SESSIONS_FILE: join(state, 'sessions.json'),
      SWICO_CLI_PROMPT_HISTORY_FILE: join(state, 'prompt-history.json'),
      SWICO_CLI_WORKERS_FILE: join(state, 'workers.json'),
      XDG_CONFIG_HOME: state,
      XDG_CACHE_HOME: state,
      SWICO_CLI_CONFIG_FILE: join(state, 'missing-user.toml'),
      SWICO_CLI_WORKSPACE: repo,
      SWICO_VERIFY_SECRET: 'fixture-secret-must-not-enter-sandbox',
    })
    await rm(fixture.link, { force: true })
    const diff = (await run('git', ['-C', repo, 'diff', '--', 'main.mjs', 'test.mjs'])).stdout
    const status = (await run('git', ['-C', repo, 'status', '--porcelain=v1'])).stdout
    const expectedDiff = (await run('git', ['-C', repo, 'diff', '--no-ext-diff', '--', 'main.mjs'])).stdout
    if (status.trim() !== ' M main.mjs') throw new Error(`Unexpected final working tree: ${bounded(status)}`)
    if (!expectedDiff.includes('+export const answer = 2')) throw new Error('Final diff did not contain the intended repair.')
    if (diff.includes('test.mjs')) throw new Error('The installed agent changed the fixture test.')
    if (fixture.state.admissions.length !== 13 || fixture.state.results.length !== 13 || fixture.state.complete !== 1 || fixture.state.cancelled !== 0) throw new Error(`Unexpected server settlement counts: ${JSON.stringify(fixture.state)}`)
    const expectedStatuses = ['succeeded', 'succeeded', 'failed', 'failed', 'failed', 'failed', 'failed', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']
    if (fixture.state.results.map(item => item.status).join(',') !== expectedStatuses.join(',')) throw new Error(`Unexpected action statuses: ${JSON.stringify(fixture.state.results)}`)
    if (existsSync(join(repo, 'denied.txt')) || existsSync(join(dirname(repo), 'outside-write.txt')) || existsSync(fixture.networkEscape)) throw new Error('A denied mutation changed the fixture filesystem.')

    const cancellationRepo = join(root, 'cancellation-repo')
    await mkdir(cancellationRepo, { recursive: true })
    await fixtureRepository(cancellationRepo)
    cancellation = await cancellationFixture(cancellationRepo)
    const cancellationEnv = await fixtureEnvironment(cancellation, state, 'installed-cancel@example.invalid')
    cancellationEnv.SWICO_CLI_WORKSPACE = cancellationRepo
    await runInstalledLauncher(launcher, cancellationRepo, cancellationEnv, { cancelOnApproval: true, cancelDelayMs: 500 })
    if (cancellation.state.cancelled !== 1 || cancellation.state.complete !== 0 || cancellation.state.rejectedResults !== 1 || !(await assertPidGone(cancellation.pidFile))) throw new Error(`Cancellation did not fence the command and descendants: ${JSON.stringify(cancellation.state)}`)

    const unknownRepo = join(root, 'unknown-repo')
    await mkdir(unknownRepo, { recursive: true })
    await fixtureRepository(unknownRepo)
    unknown = await unknownOutcomeFixture(unknownRepo)
    const unknownEnv = await fixtureEnvironment(unknown, state, 'installed-unknown@example.invalid')
    unknownEnv.SWICO_CLI_WORKSPACE = unknownRepo
    await runInstalledLauncher(launcher, unknownRepo, unknownEnv)
    await runInstalledLauncher(launcher, unknownRepo, unknownEnv)
    const mutationLines = (await readFile(unknown.mutationFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean)
    if (unknown.state.admissions.length !== 1 || unknown.state.resultAttempts !== 1 || unknown.state.complete !== 0 || mutationLines.length !== 1) throw new Error(`Unknown action outcome was replayed or settled incorrectly: ${JSON.stringify(unknown.state)}`)
    const evidence = {
      schema_version: 1,
      status: 'passed',
      package: packageName,
      version: installedManifest.version,
      artifact_sha256: artifactHash,
      platform: process.platform,
      architecture: process.arch,
      installed_launcher: true,
      launcher_preflight: launcherPreflight,
      host_network_control_reachable: true,
      network_sandbox_denied: true,
      cancellation_passed: true,
      unknown_outcome_reconciliation_passed: true,
      sandbox_verified: true,
      hostile_probes_passed: true,
      scenario: 'installed-agent-coding-loop',
      action_count: fixture.state.admissions.length,
      result_count: fixture.state.results.length,
      settlement_count: fixture.state.complete,
      final_diff_sha256: sha256(expectedDiff),
      completed_at: new Date().toISOString(),
    }
    const evidencePath = parseArg('--evidence')
    if (evidencePath) await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ ...evidence, output_tail: bounded(acceptance.output) }, null, 2))
  } finally {
    if (fixture) await new Promise(resolveClose => fixture.server.close(resolveClose))
    if (cancellation) await new Promise(resolveClose => cancellation.server.close(resolveClose))
    if (unknown) await new Promise(resolveClose => unknown.server.close(resolveClose))
    if (fixture) await rm(fixture.outside, { force: true })
    await rm(root, { recursive: true, force: true })
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { console.error(`installed-agent acceptance failed: ${bounded(error instanceof Error ? error.message : error)}`); process.exitCode = 1 }
}
