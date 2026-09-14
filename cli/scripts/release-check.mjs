import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { windowsShimInvocation } from './windows-launcher.mjs'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const keepArtifact = process.argv.includes('--keep-artifact')
const STAGE_TIMEOUT_MS = 90_000

async function resolveNpmLauncher() {
  const supplied = process.env.npm_execpath
  if (supplied && isAbsolute(supplied)) {
    await stat(supplied)
    return { command: process.execPath, prefix: [supplied], source: 'npm_execpath' }
  }
  if (process.platform === 'win32') {
    // npm.cmd cannot be passed to execFile without a shell on Windows. Find
    // the active launcher, then use its adjacent npm-cli.js through Node.
    const locations = (await exec('where.exe', ['npm.cmd'], { maxBuffer: 16 * 1024 })).stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    for (const located of locations) {
      if (!isAbsolute(located)) continue
      // The npm shim is trusted launcher metadata, not a workspace lookup.
      // Prefer the path named by the shim, then its normal adjacent layout.
      const shim = await readFile(located, 'utf8').catch(() => '')
      const named = shim.match(/%~dp0[\\/](node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js)/i)?.[1]
      const candidates = [named && join(dirname(located), named), join(dirname(located), 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean)
      for (const script of candidates) {
        try {
          await stat(script)
          return { command: process.execPath, prefix: [script], source: 'active npm.cmd JavaScript entry' }
        } catch { /* try the next trusted adjacent path */ }
      }
    }
    throw new Error('Cannot locate the active npm JavaScript entry. Run this check through npm or install npm.cmd with npm-cli.js.')
  }
  // Standalone Unix execution retains the platform npm command as a bounded
  // fallback. No workspace-local package is guessed or loaded.
  return { command: 'npm', prefix: [], source: 'active PATH npm fallback' }
}

function archiveEntries(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix ? `${prefix}/${name}` : name
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeText || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buffer.length) throw new Error(`Invalid tar entry: ${fullName}`)
    entries.set(fullName, buffer.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function finalScreenSnapshot(output) {
  const marker = '\u001b[2J\u001b[H'
  const frame = output.slice(output.lastIndexOf(marker) + marker.length)
  return frame.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '').replace(/\r/g, '')
}

function safeDiagnostic(value, limit = 4_000) {
  return String(value ?? '')
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(-limit)
}

async function run(label, command, args, options = {}) {
  process.stderr.write(`[release-check] ${label}\n`)
  stageResults[label] = 'running'
  try {
    const result = await exec(command, args, {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
      timeout: STAGE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      env: { ...process.env, npm_config_cache: join(work, 'npm-cache') },
      ...options,
    })
    stageResults[label] = 'passed'
    return result
  } catch (error) {
    stageResults[label] = `failed: ${String(error?.message ?? error).slice(0, 300)}`
    const detail = [error?.timedOut ? 'timed out' : '', error?.killed ? 'process killed' : '', error?.stderr, error?.stdout, error?.code ? `code=${error.code}` : '']
      .filter(Boolean).join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1_000)
    throw new Error(`${label} failed: ${detail || 'unknown subprocess failure'}`)
  }
}

async function runAllowFailure(label, command, args, options = {}) {
  process.stderr.write(`[release-check] ${label}\n`)
  stageResults[label] = 'running'
  try {
    const result = await exec(command, args, {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
      timeout: STAGE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      env: { ...process.env, npm_config_cache: join(work, 'npm-cache') },
      ...options,
    })
    stageResults[label] = 'passed'
    return { ...result, code: 0 }
  } catch (error) {
    stageResults[label] = `observed failure: ${String(error?.message ?? error).slice(0, 300)}`
    return {
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? '',
      code: typeof error?.code === 'number' ? error.code : undefined,
      timedOut: Boolean(error?.timedOut),
    }
  }
}

const work = await mkdtemp(join(tmpdir(), 'swico-release-'))
let controlledServer
let packedArchivePath
const stageResults = {}
const candidate = { accepted: false, source_identity: null, packed: null, stages: stageResults, pty_reports: [] }
async function sourceIdentity() {
  try {
    const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
    const status = (await exec('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()
    return { revision: revision || 'unknown', dirty: Boolean(status) }
  } catch { return { revision: 'unknown', dirty: 'unknown' } }
}

function stageStart(label) { stageResults[label] = 'running' }
async function runNpm(label, args, options = {}) {
  const launcher = await npmLauncher
  return run(label, launcher.command, [...launcher.prefix, ...args], options)
}

async function runNode(label, script, args, options = {}) {
  return run(label, process.execPath, [script, ...args], options)
}

async function runNodeAllowFailure(label, script, args, options = {}) {
  return runAllowFailure(label, process.execPath, [script, ...args], options)
}

async function runPublicShim(label, shim, args, options = {}) {
  if (process.platform !== 'win32') return run(label, shim, args, options)
  const invocation = windowsShimInvocation(shim, args)
  return run(label, invocation.command, invocation.args, { ...options, ...invocation.options })
}

async function runPty(label, command, args, options, onOutput) {
  stageStart(label)
  process.stderr.write(`[release-check] ${label}\n`)
  const runner = process.platform === 'win32' ? join(root, 'scripts', 'conpty_runner.mjs') : join(root, 'scripts', 'pty_runner.py')
  const launcher = process.platform === 'win32' ? [process.execPath, runner] : ['python3', runner]
  const child = spawn(launcher[0], [...launcher.slice(1), command, ...args], { cwd: root, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errorOutput = '', settled = false, timedOut = false, callbackError, timer, forceTimer
  let lastState = 'spawned'
  const startedAt = Date.now()
  const maxTranscript = 2 * 1024 * 1024
  let resolveResult
  const result = new Promise(resolve => { resolveResult = resolve })
  const decoder = new (await import('node:string_decoder')).StringDecoder('utf8')
  const finish = resultValue => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(forceTimer)
    child.stdin.destroy()
    const nonZero = typeof resultValue.code === 'number' && resultValue.code !== 0
    const signalled = Boolean(resultValue.signal)
    const failure = resultValue.error || resultValue.timedOut || nonZero || signalled
    const report = {
      ...resultValue,
      elapsed_ms: Date.now() - startedAt,
      last_state: lastState,
      helper_pid: child.pid ?? null,
      helper_command: String(command).split(/[\\/]/).pop()?.slice(0, 80) || 'unknown',
      output_bytes: Buffer.byteLength(output, 'utf8'),
      error_output: safeDiagnostic(errorOutput),
    }
    stageResults[label] = failure
      ? `failed: ${String(resultValue.error || (resultValue.timedOut ? 'timed out' : signalled ? `signal=${resultValue.signal}` : `code=${resultValue.code}`)).slice(0, 300)}`
      : 'passed'
    if (failure) candidate.pty_reports.push({ label, ...report })
    resolveResult(report)
  }
  child.stdout.on('data', chunk => {
    lastState = 'output'
    const text = decoder.write(chunk)
    output = `${output}${text}`.slice(-maxTranscript)
    try {
      onOutput?.(text, value => {
        if (settled) return
        if (value === null) { lastState = 'input-eof-requested'; child.stdin.end() }
        else { lastState = 'input-forwarded'; child.stdin.write(value) }
      })
    } catch (error) {
      callbackError = String(error)
      lastState = 'callback-error'
      try { child.kill('SIGTERM') } catch (killError) { callbackError = `${callbackError}; ${String(killError)}` }
    }
  })
  child.stderr.on('data', chunk => { lastState = 'helper-stderr'; errorOutput = `${errorOutput}${String(chunk)}`.slice(-maxTranscript) })
  child.once('error', error => { lastState = 'helper-error'; finish({ output, errorOutput, error: String(error) }) })
  child.once('close', (code, signal) => { lastState = 'child-close'; finish({ output: output + decoder.end(), errorOutput, code, signal, timedOut, error: callbackError }) })
  timer = setTimeout(() => {
    timedOut = true
    lastState = 'timeout'
    forceTimer = setTimeout(() => {
      if (!settled) {
        lastState = 'forced-termination'
        try { child.kill('SIGKILL') } catch (error) { callbackError = callbackError || String(error) }
      }
    }, 1_000)
    try { child.kill('SIGTERM') } catch (error) { callbackError = String(error) }
  }, STAGE_TIMEOUT_MS)
  return result
}

const npmLauncher = resolveNpmLauncher()
try {
  candidate.source_identity = await sourceIdentity()
  candidate.npm_launcher = (await npmLauncher).source
  const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  candidate.expected_version = sourceManifest.version
  const packed = await runNpm('pack', ['pack', '--json', '--ignore-scripts', '--pack-destination', work])
  const records = JSON.parse(packed.stdout)
  const record = Array.isArray(records) ? records[0] : records
  if (!record?.filename) throw new Error('npm pack did not return an artifact filename')
  const archivePath = join(work, record.filename)
  packedArchivePath = archivePath
  const archive = await readFile(archivePath)
  candidate.packed = { filename: record.filename, sha256: createHash('sha256').update(archive).digest('hex') }
  const entries = archiveEntries(gunzipSync(archive))
  const manifestBytes = entries.get('package/package.json')
  if (!manifestBytes) throw new Error('Package archive has no package.json')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.name !== sourceManifest.name || manifest.name !== '@swiveltechnologies/swico') throw new Error(`Unexpected package name: ${manifest.name}`)
  if (manifest.version !== sourceManifest.version || manifest.version !== candidate.expected_version) throw new Error(`Packed version ${manifest.version} does not match source version ${candidate.expected_version}`)
  if (manifest.license !== 'MIT') throw new Error(`Unexpected package license: ${manifest.license}`)
  if (manifest.bin?.swico !== 'dist/cli.js') throw new Error('The swico executable does not map to dist/cli.js')
  const required = [
    'package/package.json', 'package/README.md',
    'package/LICENSE', 'package/LICENSE_SCOPE.md', 'package/THIRD_PARTY_NOTICES.md',
    'package/dist/cli.js', 'package/dist/api.js', 'package/dist/config.js',
    'package/dist/agent.js', 'package/dist/contracts.js', 'package/dist/context.js',
    'package/dist/credentials.js', 'package/dist/journal.js', 'package/dist/local_sessions.js',
    'package/dist/permissions.js', 'package/dist/plan.js', 'package/dist/repository.js',
    'package/dist/output_schema.js',
    'package/dist/session.js', 'package/dist/sse.js', 'package/dist/workspace.js',
    'package/dist/completion.js', 'package/dist/configuration.js', 'package/dist/hooks.js',
    'package/dist/mcp.js', 'package/dist/mcp_server.js', 'package/dist/plugins.js',
    'package/dist/skills.js', 'package/dist/subagents.js', 'package/dist/sandbox.js', 'package/dist/terminal_output.js', 'package/dist/terminal_ui.js', 'package/dist/command_registry.js', 'package/dist/usage.js',
    'package/dist/worktrees.js', 'package/dist/cloud.js', 'package/dist/release_readiness.js', 'package/dist/build_identity.js',
  ]
  for (const entry of required) if (!entries.has(entry)) throw new Error(`Missing required release file: ${entry}`)
  const licenseText = (entries.get('package/LICENSE')?.toString('utf8') ?? '').replace(/\r\n/g, '\n')
  if (!licenseText.startsWith('MIT License\n') || !licenseText.includes('Copyright (c) 2026 Swivel Technologies and contributors')) throw new Error('Packaged CLI license text is not the approved MIT notice')
  if (!entries.get('package/LICENSE_SCOPE.md')?.toString('utf8').includes('not a repository-wide license')) throw new Error('Packaged CLI license scope is missing')
  const buildIdentityText = entries.get('package/dist/build_identity.js')?.toString('utf8') ?? ''
  const buildIdentityMatch = buildIdentityText.match(/Object\.freeze\((\{.*\})\)/s)
  if (!buildIdentityMatch) throw new Error('Packaged build identity is missing or malformed')
  const packagedIdentity = JSON.parse(buildIdentityMatch[1])
  if (packagedIdentity.revision !== candidate.source_identity.revision || packagedIdentity.dirty !== candidate.source_identity.dirty) throw new Error('Packaged build identity does not match the source identity captured before pack')
  for (const entry of entries.keys()) {
    if (entry.startsWith('package/src/') || entry.startsWith('package/test/') || entry.startsWith('package/node_modules/') || entry.startsWith('package/bin/') || entry.endsWith('.map') || /(^|\/)(?:\.env[^/]*|\.npmrc|\.pypirc|\.swico|credentials\.json|action-journal)/i.test(entry)) {
      throw new Error(`Unwanted file in release archive: ${entry}`)
    }
  }

  const prefix = join(work, 'prefix')
  await runNpm('clean-prefix install', ['install', '--global', '--prefix', prefix, '--ignore-scripts', archivePath])
  const executable = process.platform === 'win32' ? join(prefix, 'swico.cmd') : join(prefix, 'bin', 'swico')
  const packageRoot = process.platform === 'win32' ? join(prefix, 'node_modules', '@swiveltechnologies', 'swico') : join(prefix, 'lib', 'node_modules', '@swiveltechnologies', 'swico')
  const appEntry = join(packageRoot, 'dist', 'cli.js')
  // Artifact smoke tests must never inspect the operator's real keychain,
  // config, state, or sessions. Use an isolated empty state rooted in the
  // temporary release directory.
  const requestBodies = [], chatStreams = [], control = { refreshed: false, cancelled: 0, loggedOut: false, device: null }
  controlledServer = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const bodyText = Buffer.concat(chunks).toString('utf8')
    let body = {}
    try { body = bodyText ? JSON.parse(bodyText) : {} } catch { body = {} }
    requestBodies.push({ path: request.url, body })
    const jsonResponse = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    const protectedEndpoint = request.url === '/api/cli/v1/me' || request.url === '/api/cli/v1/usage' || request.url === '/api/cli/v1/chat/stream' || request.url?.startsWith('/api/cli/v1/chat/requests/')
    if (control.loggedOut && protectedEndpoint) { jsonResponse(401, { detail: 'revoked controlled session' }); return }
    if (request.url === '/api/cli/v1/device' && request.method === 'POST') {
      control.device = body
      jsonResponse(200, { device_code: 'controlled-device', user_code: 'CTRL-123', verification_uri: 'https://swico.in/cli/authorize', verification_uri_complete: 'https://swico.in/cli/authorize?user_code=CTRL-123', expires_in: 30, interval: 5 })
      return
    }
    if (request.url === '/api/cli/v1/token' && request.method === 'POST') {
      if (body.grant_type === 'refresh_token') {
        if (control.loggedOut) { jsonResponse(400, { error: 'invalid_grant', error_description: 'Refresh token is expired, reused, or revoked' }); return }
        if (body.refresh_token === 'invalid-refresh') { jsonResponse(400, { error: 'invalid_grant', error_description: 'Refresh token is expired, reused, or revoked' }); return }
        control.refreshed = true
        jsonResponse(200, { access_token: 'installed-access-new', refresh_token: 'installed-refresh-new', expires_in: 900, session_id: 'installed-session', tier: 'lite', tier_label: 'Swico Lite', scopes: ['chat'], account: { email: 'installed@example.test', name: 'Installed' } })
      } else jsonResponse(200, { access_token: 'installed-login-access', refresh_token: 'installed-login-refresh', expires_in: 900, session_id: 'installed-login-session', tier: 'standard', tier_label: 'Swico', scopes: ['chat'], account: { email: 'login@example.test', name: 'Login' } })
      return
    }
    if (request.url === '/api/cli/v1/me') {
      if (request.headers.authorization === 'Bearer installed-access-old') { jsonResponse(401, { detail: 'expired' }); return }
      jsonResponse(control.loggedOut ? 401 : 200, { email: 'installed@example.test', tier: 'lite' })
      return
    }
    if (request.url === '/api/cli/v1/usage') {
      jsonResponse(200, { tier:'lite', tier_label:'Swico Lite', wallet:{ available_micros:999988, reserved_micros:0, token_estimate:{ range_min_tokens:25000, range_max_tokens:180000 } } })
      return
    }
    if (request.url?.startsWith('/api/cli/v1/chat/requests/') && request.url.endsWith('/cancel')) {
      control.cancelled += 1; jsonResponse(200, { status: 'cancelling' }); return
    }
    if (request.url === '/api/cli/v1/logout' && request.method === 'POST') { control.loggedOut = true; jsonResponse(200, { status: 'revoked' }); return }
    if (request.url === '/api/cli/v1/chat/stream' && request.method === 'POST') {
      if (String(body.message).includes('force recoverable error')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('event: error\ndata: {"message":"temporary controlled failure"}\n\n'); return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const stream = { requestId: body.request_id, events: [] }
      chatStreams.push(stream)
      const emit = (event, payload) => {
        stream.events.push(event)
        response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      emit('thread', { thread_id: 'installed-thread', request_id: body.request_id })
      emit('status', { phase: 'generating' })
      if (String(body.message).includes('cancel me')) { setTimeout(() => response.end(), 5_000); return }
      const schema = body.output_schema
      const text = schema?.required?.includes('answer') ? '{"answer":"installed"}' : String(body.message).includes('plan') ? '1. Produce a task-only plan.\n2. Confirm the requested checks.' : body.message === 'installed rich PTY' ? 'RICH_TURN_ONE' : body.message === 'installed rich second turn' ? 'RICH_TURN_TWO' : 'installed stream response'
      emit('delta', { text })
      emit('quality', { status: 'best_effort', checks: [] })
      emit('usage', { tier: 'standard', input_tokens: 3, output_tokens: 4, charged_micros: 12, usage_source: 'estimated' })
      emit('wallet', { available_micros: 999988, reserved_micros: 0, token_estimate: { pricing_as_of: '2026-09-13T12:34:56.789Z', input_micros: 1, output_micros: 2 } })
      emit('done', { request_id: body.request_id, completion_status: 'complete', cancelled: false })
      response.end()
      return
    }
    jsonResponse(404, { detail: 'controlled endpoint not found' })
  })
  await new Promise((resolve, reject) => { controlledServer.once('error', reject); controlledServer.listen(0, '127.0.0.1', resolve) })
  const controlOrigin = `http://127.0.0.1:${controlledServer.address().port}`
  const isolatedEnv = {
    ...process.env,
    SWICO_API_BASE_URL: controlOrigin,
    SWICO_CLI_ALLOW_INSECURE_LOCAL: '1',
    SWICO_CLI_NO_BROWSER: '1',
    SWICO_CLI_CREDENTIAL_FILE: join(work, 'empty-credentials.json'),
    SWICO_CLI_STATE_DIR: join(work, 'state'),
    SWICO_CLI_CONFIG_FILE: join(work, 'config.toml'),
    SWICO_CLI_RELEASE_CHECK_INTERACTIVE: '1',
    XDG_CONFIG_HOME: join(work, 'xdg'),
  }
  const smokeOptions = { cwd: work, maxBuffer: 512 * 1024, env: isolatedEnv }
  const shimVersion = await runPublicShim('installed public launcher shim', executable, ['--version', '--json'], smokeOptions)
  if (JSON.parse(shimVersion.stdout).version !== sourceManifest.version) throw new Error('Installed public shim did not launch the candidate package')
  const shimHelp = await runPublicShim('installed public launcher help', executable, ['--help'], smokeOptions)
  if (!shimHelp.stdout.includes('Usage: swico')) throw new Error('Installed public shim did not preserve the public help contract')
  const login = await runNode('installed paid login completion', appEntry, ['login', '--tier', 'standard', '--memory-only'], smokeOptions)
  if (!login.stdout.includes('Swico')) throw new Error('Installed login did not complete')
  if (control.device?.tier !== 'standard') throw new Error('Installed login did not transmit the explicit paid tier')
  const oldTokens = { access_token: 'installed-access-old', refresh_token: 'installed-refresh-old', expires_in: 900, session_id: 'installed-session', tier: 'lite', tier_label: 'Swico Lite', scopes: ['chat'], account: { email: 'installed@example.test', name: 'Installed' } }
  await writeFile(isolatedEnv.SWICO_CLI_CREDENTIAL_FILE, JSON.stringify({ endpoint: controlOrigin, tokens: oldTokens }))
  await writeFile(join(work, 'schema.json'), JSON.stringify({ type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } }))
  await writeFile(join(work, 'AGENTS.md'), 'AGENTS_SECRET_MARKER must never be sent by a task-only plan.')
  const streamed = await runNode('installed streaming with current-token refresh', appEntry, ['ask', 'hello installed'], smokeOptions)
  if (!streamed.stdout.includes('installed stream response') || !control.refreshed) throw new Error('Installed stream/refresh smoke failed')
  const normalStream = chatStreams.find(item => item.requestId && requestBodies.some(request => request.body.request_id === item.requestId && request.body.message === 'hello installed'))
  if (!normalStream || normalStream.events.join(',') !== 'thread,status,delta,quality,usage,wallet,done' || normalStream.events.filter(event => event === 'done').length !== 1 || normalStream.events.includes('error')) throw new Error('Controlled paid stream did not exercise the complete public event envelope')
  const normalRequestId = normalStream.requestId
  if (typeof normalRequestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(normalRequestId)) throw new Error('Controlled paid stream did not preserve a usable request correlation')
  if (!streamed.stderr.includes('Quality: best_effort\n')) throw new Error('Best-effort quality was not rendered as a readable stderr diagnostic')
  const installedUiProbe = join(work, 'installed-ui-probe.mjs')
  await writeFile(installedUiProbe, `import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
const { RichTerminalUI } = await import(pathToFileURL(process.argv[2]).href)
const input = new EventEmitter(); input.isTTY = true; input.setRawMode = value => { input.raw = value }
const output = new EventEmitter(); output.isTTY = true; output.columns = 80; output.rows = 24
let transcript = ''; output.write = value => { transcript += String(value); return true }
const answers = []
const ui = new RichTerminalUI({ input, output, version: 'installed', tierLabel: 'Swico Lite', directory: '/tmp/work', branch: null,
  onMessage: async (message, emit) => { answers.push(message); emit({ event: 'status', data: { phase: 'routing' } }); emit({ event: 'delta', data: { text: 'installed controller answer' } }); emit({ event: 'quality', data: { status: 'best_effort' } }); emit({ event: 'done', data: { cancelled: false } }); return { text: 'installed controller answer', threadId: null } },
  onCommand: async () => undefined,
})
const running = ui.run(); input.emit('data', Buffer.from('installed controller\\r')); await new Promise(resolve => setTimeout(resolve, 30)); input.emit('data', Buffer.from('/exit\\r')); await running
assert.deepEqual(answers, ['installed controller']); assert.match(transcript, /installed controller answer/); assert.equal(input.raw, false)
`)
  await run('installed rich controller/event path', process.execPath, [installedUiProbe, join(packageRoot, 'dist', 'terminal_ui.js')], smokeOptions)
  let installedRichTerminal = 'not_run (native terminal adapter unavailable; installed controller passed)'
  {
    // A real PTY can still inherit TERM=dumb from a CI/container parent. The
    // rich-client acceptance needs a capable terminal profile, while the
    // ordinary non-TTY and TERM=dumb fallback is checked separately below.
    const ptySmokeOptions = { ...smokeOptions, env: { ...smokeOptions.env, TERM: 'xterm-256color', SWICO_PTY_COLUMNS: '100', SWICO_PTY_ROWS: '32' } }
    const ptyReady = await runPty('PTY positive control', process.execPath, ['-e', "if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(41); process.stdout.write('PTY_READY\\n')"], ptySmokeOptions)
    if (ptyReady.timedOut || ptyReady.error || ptyReady.code !== 0 || !ptyReady.output.includes('PTY_READY')) throw new Error(`PTY positive control failed: ${JSON.stringify({ code: ptyReady.code, signal: ptyReady.signal, error: ptyReady.error, output: ptyReady.output.slice(-500) })}`)
    let ptyPhase = 0
    let observed = ''
    const cancelledBeforeRich = control.cancelled
    const pty = await runPty('installed rich terminal PTY', process.execPath, [appEntry, '--diagnostic-startup'], ptySmokeOptions, (chunk, send) => {
      observed = `${observed}${chunk}`.slice(-64 * 1024)
      if (ptyPhase === 0 && observed.includes('Ask Swico anything')) { ptyPhase = 1; send('/usage\r') }
      else if (ptyPhase === 1 && observed.includes('Available Chat credit')) { ptyPhase = 2; send('\u001b[200~installed rich PTY\u001b[201~\r') }
      else if (ptyPhase === 2 && observed.includes('RICH_TURN_ONE')) { ptyPhase = 3; send('installed rich second turn\r') }
      else if (ptyPhase === 3 && observed.includes('RICH_TURN_TWO')) { ptyPhase = 4; send('cancel me\r') }
      else if (ptyPhase === 4 && observed.includes('Working · Ctrl+C cancels')) { ptyPhase = 5; send('\u0003') }
      else if (ptyPhase === 5 && observed.includes('Cancellation requested.')) { ptyPhase = 6; send('/exit\r') }
    })
    const visible = pty.output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    const screen = finalScreenSnapshot(pty.output)
    if (pty.timedOut || pty.error || pty.code !== 0 || ptyPhase !== 6 || !visible.includes('RICH_TURN_ONE') || !visible.includes('RICH_TURN_TWO') || control.cancelled <= cancelledBeforeRich || !pty.output.includes('[startup] rich-ui:restored') || !screen.includes(`Swico ${sourceManifest.version} · Swico Lite`) || !screen.includes('RICH_TURN_TWO') || (pty.output.match(/\u001b\[2J/g) ?? []).length > 2 || !/\u001b\[\d+;\d+H/.test(pty.output)) throw new Error(`Installed rich PTY smoke failed: ${JSON.stringify({ code: pty.code, signal: pty.signal, phase: ptyPhase, cancelled: control.cancelled - cancelledBeforeRich, error: pty.error, screen: screen.slice(-1_000), output: visible.slice(-1_000) })}`)
    installedRichTerminal = `passed (installed ${process.platform === 'win32' ? 'ConPTY' : 'Unix PTY'} with controlled API)`
    let eofSeen = false
    const eofPty = await runPty('installed rich terminal EOF cleanup', process.execPath, [appEntry, '--diagnostic-startup'], ptySmokeOptions, (chunk, send) => {
      if (!eofSeen && chunk.includes('Ask Swico anything')) { eofSeen = true; send(null) }
    })
    if (eofPty.timedOut || eofPty.error || eofPty.code !== 0 || !eofSeen || !eofPty.output.includes('[startup] rich-ui:restored')) throw new Error(`Installed rich EOF cleanup failed: ${JSON.stringify({ code: eofPty.code, signal: eofPty.signal, error: eofPty.error, output: eofPty.output.slice(-1_000) })}`)
  }
  const structured = await runNode('installed validated structured output', appEntry, ['exec', 'return an answer', '--output-schema', join(work, 'schema.json')], smokeOptions)
  if (JSON.parse(structured.stdout).answer !== 'installed') throw new Error('Installed structured output smoke failed')
  const planned = await runNode('installed task-only plan consent', appEntry, ['exec', 'plan this task', '--mode', 'plan'], smokeOptions)
  const planRequest = requestBodies.find(item => item.path === '/api/cli/v1/chat/stream' && String(item.body.message).includes('task-only plan'))
  if (!planRequest || String(planRequest.body.message).includes('AGENTS_SECRET_MARKER')) throw new Error('Installed plan consent leaked repository instructions')
  const interactiveRecovery = await new Promise(resolve => {
    const child = spawn(process.execPath, [appEntry], { cwd: work, env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    let continued = false
    const maybeContinue = () => {
      if (continued || !`${stdout}\n${stderr}`.includes('Swico operation failed')) return
      continued = true
      child.stdin.write('success after error\n/exit\n')
    }
    child.stdout.on('data', chunk => { stdout += String(chunk); maybeContinue() })
    child.stderr.on('data', chunk => { stderr += String(chunk); maybeContinue() })
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    child.stdin.write('force recoverable error\n')
    setTimeout(() => { if (!continued) child.stdin.write('success after error\n/exit\n'); setTimeout(() => child.stdin.end(), 500) }, 5_000)
  })
  const interactiveOutput = `${interactiveRecovery.stdout}\n${interactiveRecovery.stderr}`
  if (!interactiveOutput.includes('temporary controlled failure') || !interactiveOutput.includes('installed stream response')) throw new Error(`Installed same-process error recovery did not complete: ${interactiveOutput.replace(/[\\u0000-\\u001f\\u007f]/g, ' ').slice(-1_000)}`)
  const beforeRejectedCommands = requestBodies.length
  const rejectedCommands = await new Promise(resolve => {
    const child = spawn(process.execPath, [appEntry], { cwd: work, env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const commands = ['/exite', '/bogus', '/usagex', '/searchlight', '/resume', '/usage', '/exit']
    let promptCount = 0, sent = 0, settled = false
    const promptPattern = /(?:auto|chat|plan|agent)> /g
    const countPrompts = () => (stdout.match(promptPattern) ?? []).length
    const sendWhenReady = () => {
      if (settled) return
      const observed = countPrompts()
      if (observed <= promptCount) return
      promptCount = observed
      if (sent < commands.length) {
        child.stdin.write(`${commands[sent]}\n`)
        sent += 1
      }
    }
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.stdout.on('data', sendWhenReady)
    child.on('close', (code, signal) => { settled = true; resolve({ stdout, stderr, code, signal }) })
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGTERM'); resolve({ stdout, stderr, code: null, signal: 'SIGTERM' }) } }, 15_000)
    child.on('close', () => clearTimeout(timer))
  })
  const rejectedOutput = `${rejectedCommands.stdout}\n${rejectedCommands.stderr}`
  if (!rejectedOutput.includes('Unknown interactive command "/exite"') || !rejectedOutput.includes('Unknown interactive command "/bogus"') || !rejectedOutput.includes('Unknown interactive command "/usagex"') || !rejectedOutput.includes('Unknown interactive command "/searchlight"') || !rejectedOutput.includes('No local coding sessions are saved.') || !rejectedOutput.includes('Available Chat credit')) throw new Error(`Installed command safety/recovery smoke failed: ${rejectedOutput.slice(-1_000)}`)
  if (rejectedCommands.code !== 0 || requestBodies.slice(beforeRejectedCommands).some(item => item.path === '/api/cli/v1/chat/stream')) throw new Error('Rejected interactive commands admitted Chat or did not exit cleanly')
  const usage = await runNode('installed shell usage', appEntry, ['usage'], smokeOptions)
  const usageJson = await runNode('installed shell usage JSON', appEntry, ['usage', '--json'], smokeOptions)
  const readiness = await runNodeAllowFailure('installed offline release-readiness JSON', appEntry, ['release-readiness', '--json'], smokeOptions)
  let readinessBody
  try { readinessBody = JSON.parse(readiness.stdout) } catch { throw new Error(`Installed release-readiness --json did not return JSON: ${`${readiness.stdout} ${readiness.stderr}`.slice(-1_000)}`) }
  if (!readinessBody.checks || !Array.isArray(readinessBody.required_blockers)) throw new Error('Installed release-readiness JSON has an invalid public shape')
  const versionJson = await runNode('installed version identity', appEntry, ['--version', '--json'], smokeOptions)
  const cancelled = await new Promise(resolve => {
    const child = spawn(process.execPath, [appEntry, 'ask', 'cancel me'], { cwd: work, env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const deadline = Date.now() + 5_000
    const readiness = setInterval(() => {
      const admitted = requestBodies.some(item => item.path === '/api/cli/v1/chat/stream' && item.body.message === 'cancel me')
      if (admitted || Date.now() >= deadline) { clearInterval(readiness); child.kill('SIGINT') }
    }, 25)
    child.on('close', (code, signal) => { clearInterval(readiness); resolve({ code, signal }) })
  })
  if (control.cancelled < 1 || (!cancelled.code && !cancelled.signal)) throw new Error('Installed cancellation smoke did not cancel the request')
  await runNode('installed remote logout and local deletion', appEntry, ['logout'], smokeOptions)
  const retainedRevoked = await fetch(`${controlOrigin}/api/cli/v1/me`, { headers: { Authorization: 'Bearer installed-access-new', Accept: 'application/json' } })
  if (retainedRevoked.status !== 401) throw new Error(`Controlled server accepted a retained revoked credential: HTTP ${retainedRevoked.status}`)
  const retainedChat = await fetch(`${controlOrigin}/api/cli/v1/chat/stream`, { method: 'POST', headers: { Authorization: 'Bearer installed-access-new', 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: 'retained-revoked-request', message: 'must be rejected' }) })
  if (retainedChat.status !== 401) throw new Error(`Controlled chat endpoint accepted a retained revoked credential: HTTP ${retainedChat.status}`)
  const retainedRefresh = await fetch(`${controlOrigin}/api/cli/v1/token`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ grant_type:'refresh_token', refresh_token:'installed-refresh-new' }) })
  if (![400, 401].includes(retainedRefresh.status)) throw new Error(`Controlled token endpoint accepted a retained revoked refresh credential: HTTP ${retainedRefresh.status}`)
  let revoked = false
  try { await runNode('installed revoked-session rejection', appEntry, ['whoami'], smokeOptions) } catch { revoked = true }
  if (!revoked) throw new Error('Installed revoked-session rejection did not fail closed')
  const help = await runNode('installed --help', appEntry, ['--help'], smokeOptions)
  const version = await runNode('installed --version', appEntry, ['--version'], smokeOptions)
  const doctor = await runNode('installed offline doctor', appEntry, ['doctor'], { ...smokeOptions, env: { ...isolatedEnv, SWICO_CLI_DOCTOR_OFFLINE: '1' } })
  const config = await runNode('installed config validate', appEntry, ['config', 'validate'], smokeOptions)
  const completion = await runNode('installed completion', appEntry, ['completion', 'bash'], smokeOptions)
  const sandbox = await runNode('installed sandbox status', appEntry, ['sandbox', 'status'], smokeOptions)
  if (!help.stdout.includes('Usage: swico')) throw new Error('Installed --help output is invalid')
  if (version.stdout.trim() !== manifest.version) throw new Error(`Installed version mismatch: ${version.stdout.trim()}`)
  if (!config.stdout.includes('Configuration is valid')) throw new Error('Installed config validation output is invalid')
  if (!completion.stdout.includes('swico')) throw new Error('Installed completion output is invalid')
  if (!sandbox.stdout.includes('"diagnostic"')) throw new Error('Installed sandbox status output is invalid')
  if (!usage.stdout.includes('Available Chat credit') || !JSON.parse(usageJson.stdout).wallet) throw new Error('Installed usage command output is invalid')
  const versionIdentity = JSON.parse(versionJson.stdout)
  if (versionIdentity.version !== manifest.version || !String(versionIdentity.executable).includes('prefix')) throw new Error('Installed version identity did not identify the running executable')
  if (versionIdentity.revision !== candidate.source_identity.revision || versionIdentity.dirty !== candidate.source_identity.dirty) throw new Error('Installed version identity does not match the packaged source identity')
  const doctorBody = JSON.parse(doctor.stdout)
  if (doctorBody.build?.version !== manifest.version || !String(doctorBody.build?.executable).includes('prefix')) throw new Error('Installed doctor did not identify the running executable')
  if (doctorBody.build?.revision !== candidate.source_identity.revision || doctorBody.build?.dirty !== candidate.source_identity.dirty) throw new Error('Installed doctor identity does not match the packaged source identity')
  await writeFile(isolatedEnv.SWICO_CLI_CREDENTIAL_FILE, JSON.stringify({ endpoint: controlOrigin, tokens: { ...oldTokens, access_token:'installed-access-old', refresh_token:'invalid-refresh' } }))
  let invalidGrant = false
  try { await runNode('installed invalid-grant feedback', appEntry, ['whoami'], smokeOptions) } catch (error) { invalidGrant = String(error).includes('terminal authorization is no longer valid') || String(error).includes('swico login --tier') }
  if (!invalidGrant) throw new Error('Installed invalid_grant feedback was not actionable')
  const digest = createHash('sha256').update(archive).digest('hex')
  candidate.accepted = installedRichTerminal.startsWith('passed')
  if (keepArtifact && candidate.accepted) await copyFile(archivePath, join(root, record.filename))
  if (!candidate.accepted) process.exitCode = 2
  console.log(JSON.stringify({
    name: manifest.name,
    accepted: candidate.accepted,
    source_identity: await sourceIdentity(),
    version: manifest.version,
    filename: record.filename,
    sha256: digest,
    archive_files: [...entries.keys()].sort(),
    installed_checks: { login_paid_tier: 'passed (controlled API)', stream_refresh: 'passed (controlled API)', rich_terminal: installedRichTerminal, structured_output: 'passed (controlled API)', plan_consent: 'passed (task-only)', error_recovery: 'passed', command_safety: 'passed (interactive controlled API)', optional_resume: 'passed (installed offline)', release_readiness_json: `passed (installed offline; exit ${readiness.code ?? 'unknown'})`, cancellation: 'passed', logout_revocation: 'passed (controlled API)', usage: 'passed (controlled API)', auth_error_feedback: 'passed (controlled API)', help: 'passed', version: 'passed', doctor: 'passed (offline)', config_validate: 'passed', completion: 'passed', sandbox_status: 'passed (readiness only)' },
    installed_executable: executable,
    installed_js_entry: appEntry,
    retained_artifact: keepArtifact ? join(root, record.filename) : null,
    doctor_output: JSON.parse(doctor.stdout),
  }, null, 2))
} catch (error) {
  candidate.error = String(error?.message ?? error).slice(0, 1_000)
  if (keepArtifact && packedArchivePath) {
    const failedPath = join(root, `${candidate.packed?.filename ?? 'swico-candidate.tgz'}.failed-${candidate.packed?.sha256?.slice(0, 12) ?? 'unknown'}`)
    await copyFile(packedArchivePath, failedPath).catch(() => undefined)
    candidate.failed_artifact = failedPath
  }
  process.stderr.write(`${JSON.stringify({ ...candidate, status: 'failed' }, null, 2)}\n`)
  throw error
} finally {
  if (controlledServer) await new Promise(resolve => controlledServer.close(resolve))
  await rm(work, { recursive: true, force: true })
}
