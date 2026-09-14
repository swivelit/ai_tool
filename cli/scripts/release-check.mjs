import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const keepArtifact = process.argv.includes('--keep-artifact')
const STAGE_TIMEOUT_MS = 90_000

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

async function run(label, command, args, options = {}) {
  process.stderr.write(`[release-check] ${label}\n`)
  try {
    return await exec(command, args, {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
      timeout: STAGE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      env: { ...process.env, npm_config_cache: join(work, 'npm-cache') },
      ...options,
    })
  } catch (error) {
    const detail = [error?.timedOut ? 'timed out' : '', error?.killed ? 'process killed' : '', error?.stderr, error?.stdout, error?.code ? `code=${error.code}` : '']
      .filter(Boolean).join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1_000)
    throw new Error(`${label} failed: ${detail || 'unknown subprocess failure'}`)
  }
}

const work = await mkdtemp(join(tmpdir(), 'swico-release-'))
let controlledServer
async function sourceIdentity() {
  try {
    const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
    const status = (await exec('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()
    return { revision: revision || 'unknown', dirty: Boolean(status) }
  } catch { return { revision: 'unknown', dirty: 'unknown' } }
}
try {
  const packed = await run('pack', npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', work])
  const records = JSON.parse(packed.stdout)
  const record = Array.isArray(records) ? records[0] : records
  if (!record?.filename) throw new Error('npm pack did not return an artifact filename')
  const archivePath = join(work, record.filename)
  const archive = await readFile(archivePath)
  const entries = archiveEntries(gunzipSync(archive))
  const manifestBytes = entries.get('package/package.json')
  if (!manifestBytes) throw new Error('Package archive has no package.json')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.name !== '@swiveltechnologies/swico') throw new Error(`Unexpected package name: ${manifest.name}`)
  if (manifest.bin?.swico !== 'dist/cli.js') throw new Error('The swico executable does not map to dist/cli.js')
  const required = [
    'package/package.json', 'package/README.md',
    'package/dist/cli.js', 'package/dist/api.js', 'package/dist/config.js',
    'package/dist/agent.js', 'package/dist/contracts.js', 'package/dist/context.js',
    'package/dist/credentials.js', 'package/dist/journal.js', 'package/dist/local_sessions.js',
    'package/dist/permissions.js', 'package/dist/plan.js', 'package/dist/repository.js',
    'package/dist/output_schema.js',
    'package/dist/session.js', 'package/dist/sse.js', 'package/dist/workspace.js',
    'package/dist/completion.js', 'package/dist/configuration.js', 'package/dist/hooks.js',
    'package/dist/mcp.js', 'package/dist/mcp_server.js', 'package/dist/plugins.js',
    'package/dist/skills.js', 'package/dist/subagents.js', 'package/dist/sandbox.js', 'package/dist/terminal_output.js', 'package/dist/command_registry.js', 'package/dist/usage.js',
    'package/dist/worktrees.js', 'package/dist/cloud.js', 'package/dist/release_readiness.js',
  ]
  for (const entry of required) if (!entries.has(entry)) throw new Error(`Missing required release file: ${entry}`)
  for (const entry of entries.keys()) {
    if (entry.startsWith('package/src/') || entry.startsWith('package/test/') || entry.startsWith('package/node_modules/') || entry.startsWith('package/bin/') || entry.endsWith('.map') || /(^|\/)(?:\.env[^/]*|\.npmrc|\.pypirc|\.swico|credentials\.json|action-journal)/i.test(entry)) {
      throw new Error(`Unwanted file in release archive: ${entry}`)
    }
  }

  const prefix = join(work, 'prefix')
  await run('clean-prefix install', npm, ['install', '--global', '--prefix', prefix, '--ignore-scripts', archivePath])
  const executable = process.platform === 'win32' ? join(prefix, 'swico.cmd') : join(prefix, 'bin', 'swico')
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
      const text = schema?.required?.includes('answer') ? '{"answer":"installed"}' : String(body.message).includes('plan') ? '1. Produce a task-only plan.\n2. Confirm the requested checks.' : 'installed stream response'
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
  const login = await run('installed paid login completion', executable, ['login', '--tier', 'standard', '--memory-only'], smokeOptions)
  if (!login.stdout.includes('Swico')) throw new Error('Installed login did not complete')
  if (control.device?.tier !== 'standard') throw new Error('Installed login did not transmit the explicit paid tier')
  const oldTokens = { access_token: 'installed-access-old', refresh_token: 'installed-refresh-old', expires_in: 900, session_id: 'installed-session', tier: 'lite', tier_label: 'Swico Lite', scopes: ['chat'], account: { email: 'installed@example.test', name: 'Installed' } }
  await writeFile(isolatedEnv.SWICO_CLI_CREDENTIAL_FILE, JSON.stringify({ endpoint: controlOrigin, tokens: oldTokens }))
  await writeFile(join(work, 'schema.json'), JSON.stringify({ type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } }))
  await writeFile(join(work, 'AGENTS.md'), 'AGENTS_SECRET_MARKER must never be sent by a task-only plan.')
  const streamed = await run('installed streaming with current-token refresh', executable, ['ask', 'hello installed'], smokeOptions)
  if (!streamed.stdout.includes('installed stream response') || !control.refreshed) throw new Error('Installed stream/refresh smoke failed')
  const normalStream = chatStreams.find(item => item.requestId && requestBodies.some(request => request.body.request_id === item.requestId && request.body.message === 'hello installed'))
  if (!normalStream || normalStream.events.join(',') !== 'thread,status,delta,quality,usage,wallet,done' || normalStream.events.filter(event => event === 'done').length !== 1 || normalStream.events.includes('error')) throw new Error('Controlled paid stream did not exercise the complete public event envelope')
  const normalRequestId = normalStream.requestId
  if (typeof normalRequestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(normalRequestId)) throw new Error('Controlled paid stream did not preserve a usable request correlation')
  if (!streamed.stderr.includes('Quality: best_effort\n')) throw new Error('Best-effort quality was not rendered as a readable stderr diagnostic')
  const structured = await run('installed validated structured output', executable, ['exec', 'return an answer', '--output-schema', join(work, 'schema.json')], smokeOptions)
  if (JSON.parse(structured.stdout).answer !== 'installed') throw new Error('Installed structured output smoke failed')
  const planned = await run('installed task-only plan consent', executable, ['exec', 'plan this task', '--mode', 'plan'], smokeOptions)
  const planRequest = requestBodies.find(item => item.path === '/api/cli/v1/chat/stream' && String(item.body.message).includes('task-only plan'))
  if (!planRequest || String(planRequest.body.message).includes('AGENTS_SECRET_MARKER')) throw new Error('Installed plan consent leaked repository instructions')
  const interactiveRecovery = await new Promise(resolve => {
    const child = spawn(executable, [], { cwd: work, env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'] })
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
    const child = spawn(executable, [], { cwd: work, env: isolatedEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('close', (code, signal) => resolve({ stdout, stderr, code, signal }))
    const commands = ['/exite', '/bogus', '/usagex', '/searchlight', '/usage', '/exit']
    let next = 0
    const timer = setInterval(() => {
      if (next < commands.length) { child.stdin.write(`${commands[next]}\n`); next += 1; return }
      if (stdout.includes('Available Chat credit')) { clearInterval(timer); child.stdin.end() }
    }, 250)
    setTimeout(() => { clearInterval(timer); child.stdin.end() }, 10_000)
  })
  const rejectedOutput = `${rejectedCommands.stdout}\n${rejectedCommands.stderr}`
  if (!rejectedOutput.includes('Unknown interactive command "/exite"') || !rejectedOutput.includes('Unknown interactive command "/bogus"') || !rejectedOutput.includes('Unknown interactive command "/usagex"') || !rejectedOutput.includes('Unknown interactive command "/searchlight"') || !rejectedOutput.includes('Available Chat credit')) throw new Error(`Installed command safety/recovery smoke failed: ${rejectedOutput.slice(-1_000)}`)
  if (rejectedCommands.code !== 0 || requestBodies.slice(beforeRejectedCommands).some(item => item.path === '/api/cli/v1/chat/stream')) throw new Error('Rejected interactive commands admitted Chat or did not exit cleanly')
  const usage = await run('installed shell usage', executable, ['usage'], smokeOptions)
  const usageJson = await run('installed shell usage JSON', executable, ['usage', '--json'], smokeOptions)
  const versionJson = await run('installed version identity', executable, ['--version', '--json'], smokeOptions)
  const cancelled = await new Promise(resolve => {
    const child = spawn(executable, ['ask', 'cancel me'], { cwd: work, env: isolatedEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGINT'), 500)
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
  if (control.cancelled < 1 || (!cancelled.code && !cancelled.signal)) throw new Error('Installed cancellation smoke did not cancel the request')
  await run('installed remote logout and local deletion', executable, ['logout'], smokeOptions)
  const retainedRevoked = await fetch(`${controlOrigin}/api/cli/v1/me`, { headers: { Authorization: 'Bearer installed-access-new', Accept: 'application/json' } })
  if (retainedRevoked.status !== 401) throw new Error(`Controlled server accepted a retained revoked credential: HTTP ${retainedRevoked.status}`)
  const retainedChat = await fetch(`${controlOrigin}/api/cli/v1/chat/stream`, { method: 'POST', headers: { Authorization: 'Bearer installed-access-new', 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: 'retained-revoked-request', message: 'must be rejected' }) })
  if (retainedChat.status !== 401) throw new Error(`Controlled chat endpoint accepted a retained revoked credential: HTTP ${retainedChat.status}`)
  const retainedRefresh = await fetch(`${controlOrigin}/api/cli/v1/token`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ grant_type:'refresh_token', refresh_token:'installed-refresh-new' }) })
  if (![400, 401].includes(retainedRefresh.status)) throw new Error(`Controlled token endpoint accepted a retained revoked refresh credential: HTTP ${retainedRefresh.status}`)
  let revoked = false
  try { await run('installed revoked-session rejection', executable, ['whoami'], smokeOptions) } catch { revoked = true }
  if (!revoked) throw new Error('Installed revoked-session rejection did not fail closed')
  const help = await run('installed --help', executable, ['--help'], smokeOptions)
  const version = await run('installed --version', executable, ['--version'], smokeOptions)
  const doctor = await run('installed offline doctor', executable, ['doctor'], { ...smokeOptions, env: { ...isolatedEnv, SWICO_CLI_DOCTOR_OFFLINE: '1' } })
  const config = await run('installed config validate', executable, ['config', 'validate'], smokeOptions)
  const completion = await run('installed completion', executable, ['completion', 'bash'], smokeOptions)
  const sandbox = await run('installed sandbox status', executable, ['sandbox', 'status'], smokeOptions)
  if (!help.stdout.includes('Usage: swico')) throw new Error('Installed --help output is invalid')
  if (version.stdout.trim() !== manifest.version) throw new Error(`Installed version mismatch: ${version.stdout.trim()}`)
  if (!config.stdout.includes('Configuration is valid')) throw new Error('Installed config validation output is invalid')
  if (!completion.stdout.includes('swico')) throw new Error('Installed completion output is invalid')
  if (!sandbox.stdout.includes('"diagnostic"')) throw new Error('Installed sandbox status output is invalid')
  if (!usage.stdout.includes('Available Chat credit') || !JSON.parse(usageJson.stdout).wallet) throw new Error('Installed usage command output is invalid')
  const versionIdentity = JSON.parse(versionJson.stdout)
  if (versionIdentity.version !== manifest.version || !String(versionIdentity.executable).includes('prefix')) throw new Error('Installed version identity did not identify the running executable')
  const doctorBody = JSON.parse(doctor.stdout)
  if (doctorBody.build?.version !== manifest.version || !String(doctorBody.build?.executable).includes('prefix')) throw new Error('Installed doctor did not identify the running executable')
  await writeFile(isolatedEnv.SWICO_CLI_CREDENTIAL_FILE, JSON.stringify({ endpoint: controlOrigin, tokens: { ...oldTokens, access_token:'installed-access-old', refresh_token:'invalid-refresh' } }))
  let invalidGrant = false
  try { await run('installed invalid-grant feedback', executable, ['whoami'], smokeOptions) } catch (error) { invalidGrant = String(error).includes('terminal authorization is no longer valid') || String(error).includes('swico login --tier') }
  if (!invalidGrant) throw new Error('Installed invalid_grant feedback was not actionable')
  const digest = createHash('sha256').update(archive).digest('hex')
  if (keepArtifact) await copyFile(archivePath, join(root, record.filename))
  console.log(JSON.stringify({
    name: manifest.name,
    source_identity: await sourceIdentity(),
    version: manifest.version,
    filename: record.filename,
    sha256: digest,
    archive_files: [...entries.keys()].sort(),
    installed_checks: { login_paid_tier: 'passed (controlled API)', stream_refresh: 'passed (controlled API)', structured_output: 'passed (controlled API)', plan_consent: 'passed (task-only)', error_recovery: 'passed', command_safety: 'passed (interactive controlled API)', cancellation: 'passed', logout_revocation: 'passed (controlled API)', usage: 'passed (controlled API)', auth_error_feedback: 'passed (controlled API)', help: 'passed', version: 'passed', doctor: 'passed (offline)', config_validate: 'passed', completion: 'passed', sandbox_status: 'passed (readiness only)' },
    installed_executable: executable,
    retained_artifact: keepArtifact ? join(root, record.filename) : null,
    doctor_output: JSON.parse(doctor.stdout),
  }, null, 2))
} finally {
  if (controlledServer) await new Promise(resolve => controlledServer.close(resolve))
  await rm(work, { recursive: true, force: true })
}
