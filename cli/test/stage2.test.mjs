import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSummary, loadConfig, validateMcpDefinition } from '../dist/configuration.js'
import { McpManager } from '../dist/mcp.js'
import { completion } from '../dist/completion.js'
import { listSkills, selectSkill } from '../dist/skills.js'
import { inspectPlugin, trustPlugin, runTrustedPlugin } from '../dist/plugins.js'
import { HookBus, executableHookHash, runExecutableHook as runHook } from '../dist/hooks.js'
import { probeEndpoint, streamChat } from '../dist/api.js'
import { parseTaskArguments, taskText } from '../dist/arguments.js'
import { loadOutputValidator, parseStructuredOutput, publishOutputAtomically } from '../dist/output_schema.js'
import { cloudExec, cloudEvents, cloudList } from '../dist/cloud.js'
import { createCloudSnapshot } from '../dist/cloud_snapshot.js'

test('task parser keeps boolean search switches from consuming the prompt', () => {
  const parsed = parseTaskArguments(['ask', '--search', 'latest', 'status'], 'ask')
  assert.equal(taskText(parsed), 'latest status')
  assert.equal(parsed.flags.has('--search'), true)
  assert.throws(() => parseTaskArguments(['exec', '--search', '--no-search', 'task'], 'exec'), /cannot be used together/)
  assert.throws(() => parseTaskArguments(['ask', '--unknown', 'task'], 'ask'), /Unknown option/)
})

test('output schemas validate structured responses and publish atomically without clobbering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-output-schema-')), schemaPath = join(root, 'schema.json'), outputPath = join(root, 'result.json')
  try {
    await writeFile(schemaPath, JSON.stringify({ type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } }))
    const validator = await loadOutputValidator(schemaPath)
    assert.equal(parseStructuredOutput('{"answer":"ok"}', validator), '{"answer":"ok"}\n')
    assert.throws(() => parseStructuredOutput('{"answer":3}', validator), /did not match/)
    await publishOutputAtomically(outputPath, '{"answer":"ok"}\n')
    await assert.rejects(() => publishOutputAtomically(outputPath, '{"answer":"replacement"}\n'), /already exists/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('doctor probes the explicit no-cost rollout health contract', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ status: 'ok', cli_enabled: false, agent_enabled: false, cloud_agent_enabled: false, message: 'Swico CLI is disabled.' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    assert.deepEqual(await probeEndpoint({ SWICO_API_BASE_URL: 'https://api.example.test' }), { status: 200, state: 'disabled', agent_enabled: false, detail: 'Swico CLI is disabled.' })
    assert.match(calls[0], /\/api\/cli\/v1\/health$/)
  } finally { globalThis.fetch = originalFetch }
})

test('cloud CLI uses durable job/list/event endpoints and an idempotent request identity', async () => {
  const originalFetch = globalThis.fetch, requests = []
  globalThis.fetch = async (url, init = {}) => { requests.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined }); return new Response(JSON.stringify({ id: 'job-1', status: 'queued', items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) }
  try {
    const tokens = { access_token: 'opaque', refresh_token: 'opaque', expires_in: 900, session_id: 'cloud', tier: 'lite', tier_label: 'Swico Lite', scopes: ['chat', 'agent'], account: { email: 'test@example.com', name: 'Test' } }
    await cloudExec(tokens, 'inspect', { SWICO_API_BASE_URL: 'https://api.example.test' })
    await cloudList(tokens, { SWICO_API_BASE_URL: 'https://api.example.test' })
    await cloudEvents(tokens, 'job-1', { SWICO_API_BASE_URL: 'https://api.example.test' })
    assert.equal(requests[0].body.source, 'workspace_snapshot'); assert.match(requests[0].body.request_id, /^[0-9a-f-]{36}$/)
    assert.match(requests[2].url, /\/cloud\/jobs\/job-1\/events$/)
  } finally { globalThis.fetch = originalFetch }
})

test('cloud snapshot transfers bytes only after explicit caller consent and filters secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-cloud-snapshot-'))
  try {
    await writeFile(join(root, 'main.txt'), 'safe\n')
    await writeFile(join(root, '.env.staging'), 'secret\n')
    const snapshot = await createCloudSnapshot(root)
    assert.deepEqual(snapshot.files.map(item => item.path), ['main.txt'])
    assert.equal(Buffer.from(snapshot.files[0].data_base64, 'base64').toString(), 'safe\n')
    assert.equal(snapshot.files[0].sha256.length, 64)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('project configuration can narrow but cannot trust an MCP server or enable hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-config-'))
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, '.swico'), { recursive: true }))
    await writeFile(join(root, '.swico', 'config.toml'), 'search_mode = "off"\n[hooks]\nenabled = true\n[mcp."unsafe"]\ntransport = "stdio"\ncommand = "node"\n')
    const user = { ...process.env, SWICO_CLI_CONFIG_FILE: join(root, 'user.toml'), SWICO_CLI_WORKSPACE: root }
    const loaded = await loadConfig(root, user)
    assert.equal(loaded.effective.searchMode, 'off')
    assert.equal(loaded.effective.hooksEnabled, false)
    assert.equal(loaded.effective.mcp[0].trusted, false)
    assert.equal(configSummary(loaded.effective).hooks_enabled, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('MCP manager uses the official stdio transport, discovers tools and gates unknown calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-mcp-'))
  try {
    const definition = { name: 'fake', transport: 'stdio', command: process.execPath, args: [join(process.cwd(), 'test/fixtures/fake-mcp.mjs')], source: 'user', trusted: true }
    validateMcpDefinition(definition, true)
    const testSandbox = { status: () => ({ implementation: 'test', available: true, reason: 'test adapter', policy: 'read-only', network: 'disabled', writable_roots: [] }), wrap: argv => ({ command: argv[0], args: argv.slice(1) }) }
    const manager = new McpManager({ source: 'user', path: '', searchMode: 'auto', defaultMode: 'auto', autoSkills: true, hooksEnabled: false, sandboxPolicy: 'workspace-write', approvalPolicy: 'always', mcp: [definition] }, join(root, 'journal.jsonl'), testSandbox, true)
    const tools = await manager.discover('fake')
    assert.deepEqual(tools.map(item => [item.name, item.capability]), [['echo', 'read'], ['write_note', 'unknown']])
    await assert.rejects(() => manager.call('fake', 'echo', { value: 'ok' }, async () => false), /not approved/)
    assert.equal(await manager.call('fake', 'echo', { value: 'ok' }, async () => true), '[{"type":"text","text":"ok"}]')
    await assert.rejects(() => manager.call('fake', 'write_note', { value: 'x' }, async () => false), /not approved/)
    await manager.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('skills load descriptions before bounded instructions and completion is offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-skills-'))
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: root }
    await writeFile(join(root, 'config.toml'), '')
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'swico', 'skills', 'testing'), { recursive: true }))
    await writeFile(join(root, 'swico', 'skills', 'testing', 'SKILL.md'), '---\nname: testing\ndescription: test failures\n---\nRun focused tests.')
    const skills = await listSkills(undefined, root, env)
    assert.equal(selectSkill('fix test failures', skills)?.name, 'testing')
    assert.match(completion('bash'), /complete -F/)
    assert.throws(() => completion('unknown'), /bash, zsh/)
    for (const shell of ['bash', 'zsh', 'fish', 'powershell']) for (const command of ['sandbox', 'worktree', 'cloud', 'mcp-server', 'release-readiness']) assert.match(completion(shell), new RegExp(command.replace('-', '\\-')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('plugin trust is explicit and invalidated by manifest or entrypoint changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-plugin-'))
  try {
    const env = { ...process.env, SWICO_CLI_PLUGIN_TRUST_FILE: join(root, 'trust.json') }
    await writeFile(join(root, 'index.mjs'), 'console.log("safe")\n')
    await writeFile(join(root, 'swico-plugin.json'), JSON.stringify({ name: 'safe', version: '1.0.0', entrypoint: 'index.mjs', permissions: ['read'] }))
    assert.equal((await inspectPlugin(root, env)).trusted, false)
    assert.equal((await trustPlugin(root, env)).trusted, true)
    await writeFile(join(root, 'index.mjs'), 'console.log("changed")\n')
    assert.equal((await inspectPlugin(root, env)).trusted, false)
    await writeFile(join(root, 'swico-plugin.json'), JSON.stringify({ name: 'bad', version: '1', main: 'index.js' }))
    await assert.rejects(() => inspectPlugin(root, env), /executable field/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('trusted executable plugin dispatches only through the verified sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-plugin-run-'))
  const trustPath = join(root, '..', 'swico-plugin-run-trust.json')
  try {
    const env = { ...process.env, SWICO_CLI_PLUGIN_TRUST_FILE: trustPath }
    await writeFile(join(root, 'index.mjs'), 'process.stdout.write("plugin-ok")\n')
    await writeFile(join(root, 'swico-plugin.json'), JSON.stringify({ name: 'runner', version: '1.0.0', entrypoint: 'index.mjs', permissions: ['read'] }))
    await trustPlugin(root, env)
    const sandbox = { status: () => ({ implementation: 'unavailable', available: true, reason: 'test verified', policy: 'read-only', network: 'disabled', writable_roots: [] }), spawn: (argv, options) => spawn(argv[0], argv.slice(1), options) }
    const result = await runTrustedPlugin(root, [], sandbox, true, undefined, env)
    assert.equal(result.code, 0); assert.equal(result.stdout, 'plugin-ok')
    await assert.rejects(() => runTrustedPlugin(root, [], sandbox, false, undefined, env), /verified sandbox/)
  } finally { await rm(root, { recursive: true, force: true }); await rm(trustPath, { force: true }) }
})

test('executable hooks require a current hash and verified sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-hook-'))
  try {
    const sandbox = { status: () => ({ implementation: 'test', available: true, reason: 'verified', policy: 'read-only', network: 'disabled', writable_roots: [] }), wrap: argv => ({ command: argv[0], args: argv.slice(1) }) }
    const hook = { event: 'user_prompt', command: process.execPath, args: ['-e', 'process.stdout.write("hook-ok")'], trusted: true, approvedHash: '' }
    hook.approvedHash = await executableHookHash(hook)
    const result = await runHook(hook, { event: 'user_prompt', summary: 'bounded' }, sandbox, true)
    assert.equal(result.code, 0); assert.equal(result.stdout, 'hook-ok')
    await assert.rejects(() => runHook({ ...hook, approvedHash: '0'.repeat(64) }, { event: 'user_prompt' }, sandbox, true), /trust is invalid/)
    await assert.rejects(() => runHook(hook, { event: 'user_prompt' }, sandbox, false), /verified sandbox/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('trusted executable hooks are invoked by the real session lifecycle bus', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-hook-bus-'))
  try {
    const marker = join(root, 'session-started')
    const sandbox = { status: () => ({ implementation: 'test', available: true, reason: 'verified', policy: 'read-only', network: 'disabled', writable_roots: [] }), wrap: argv => ({ command: argv[0], args: argv.slice(1) }) }
    const hook = { event: 'session_start', command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`], trusted: true, approvedHash: '' }
    hook.approvedHash = await executableHookHash(hook)
    const seen = []
    const bus = new HookBus([hook], sandbox, true)
    bus.on('session_start', payload => seen.push(payload.event))
    await bus.emit({ event: 'session_start', run_id: 'run-test', summary: 'bounded' })
    assert.deepEqual(seen, ['session_start'])
    assert.equal((await readFile(marker, 'utf8')), 'ok')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('stop and interrupt hooks have explicit lifecycle semantics', async () => {
  const events = []
  const bus = new HookBus([], { status: () => ({ implementation: 'test', available: true, reason: 'verified', policy: 'read-only', network: 'disabled', writable_roots: [] }) }, true)
  bus.on('stop', payload => events.push([payload.event, payload.run_id]))
  bus.on('interrupt', payload => events.push([payload.event, payload.run_id]))
  await bus.emit({ event: 'stop', run_id: 'run-stop', summary: 'terminal response' })
  const controller = new AbortController(); controller.abort()
  const interrupting = new HookBus([], { status: () => ({ implementation: 'test', available: true, reason: 'verified', policy: 'read-only', network: 'disabled', writable_roots: [] }) }, true, controller.signal)
  interrupting.on('interrupt', payload => events.push([payload.event, payload.run_id]))
  await interrupting.emit({ event: 'interrupt', run_id: 'run-interrupt', summary: 'user cancellation' }, { allowAfterAbort: true })
  assert.deepEqual(events, [['stop', 'run-stop'], ['interrupt', 'run-interrupt']])
})

test('CLI chat carries server-controlled search mode and temporary attachments through the real stream client', async () => {
  const originalFetch = globalThis.fetch; let payload; const events = []
  globalThis.fetch = async (_url, init = {}) => { payload = JSON.parse(String(init.body)); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: thread\ndata: {"thread_id":"t1"}\n\nevent: delta\ndata: {"text":"ok"}\n\nevent: done\ndata: {}\n\n')); controller.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }) }
  try {
    const tokens = { access_token: 'opaque', refresh_token: 'opaque', expires_in: 900, session_id: 's', tier: 'lite', tier_label: 'Swico Lite', scopes: ['chat'], account: { email: 'test@example.com', name: 'Test' } }
    const answer = await streamChat(tokens, 'latest status', undefined, event => events.push(event), { SWICO_API_BASE_URL: 'https://api.example.test' }, { searchMode: 'on', attachmentIds: ['upload-1'], testTokenProvider: async () => tokens.access_token })
    assert.equal(answer.text, 'ok'); assert.deepEqual(payload.attachment_ids, ['upload-1']); assert.equal(payload.search_mode, 'on')
    assert.deepEqual(events.map(event => event.event), ['thread', 'delta', 'done'])
  } finally { globalThis.fetch = originalFetch }
})

test('streamChat uses one event reducer for final flush, empty answers, and UTF-8 chunks', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode('event: thread\ndata: {"thread_id":"flush-thread"}\r\n\r\nevent: delta\ndata: {"text":"தமிழ்"}\n\n'.slice(0, 18)))
      controller.enqueue(encoder.encode('event: thread\ndata: {"thread_id":"flush-thread"}\r\n\r\nevent: delta\ndata: {"text":"தமிழ்"}\n\nevent: done\ndata: {"completion_status":"complete"}'.slice(18)))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  try {
    const events = []
    const result = await streamChat({ access_token: 'opaque' }, 'hello', undefined, event => events.push(event), { SWICO_API_BASE_URL: 'https://api.example.test' }, { testTokenProvider: async () => 'opaque' })
    assert.equal(result.threadId, 'flush-thread')
    assert.equal(result.text, 'தமிழ்')
    assert.deepEqual(events.map(event => event.event), ['thread', 'delta', 'done'])
  } finally { globalThis.fetch = originalFetch }
})

test('streamChat preserves safe stream errors and rejects cancelled or contradictory terminals', async () => {
  const originalFetch = globalThis.fetch
  const tokens = { access_token: 'opaque' }
  const responseFor = (body) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  try {
    globalThis.fetch = async () => responseFor('event: delta\ndata: {"text":"partial"}\n\nevent: error\ndata: {"code":"delivery_failed","message":"recorded result","request_id":"request-1","retryable":false}\n\n')
    await assert.rejects(() => streamChat(tokens, 'hello', undefined, undefined, { SWICO_API_BASE_URL: 'https://api.example.test' }, { testTokenProvider: async () => 'opaque' }), error => error.code === 'delivery_failed' && error.requestId === 'request-1' && error.retryable === false)
    globalThis.fetch = async () => responseFor('event: done\ndata: {"cancelled":true}\n\n')
    await assert.rejects(() => streamChat(tokens, 'hello', undefined, undefined, { SWICO_API_BASE_URL: 'https://api.example.test' }, { testTokenProvider: async () => 'opaque' }), error => error.code === 'cancelled')
    globalThis.fetch = async () => responseFor('event: done\ndata: {}\n\nevent: done\ndata: {}\n\n')
    await assert.rejects(() => streamChat(tokens, 'hello', undefined, undefined, { SWICO_API_BASE_URL: 'https://api.example.test' }, { testTokenProvider: async () => 'opaque' }), /more than one terminal/)
  } finally { globalThis.fetch = originalFetch }
})

test('streamChat parses structured non-2xx details before SSE begins', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: { code: 'insufficient_budget', message: 'Not enough Chat credit.', request_id: 'request-2', retryable: false } }), { status: 402, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(() => streamChat({ access_token: 'opaque' }, 'hello', undefined, undefined, { SWICO_API_BASE_URL: 'https://api.example.test' }, { testTokenProvider: async () => 'opaque' }), error => error.status === 402 && error.code === 'insufficient_budget' && error.requestId === 'request-2' && error.retryable === false)
  } finally { globalThis.fetch = originalFetch }
})

test('materially different output schemas are carried as distinct bounded requests', async () => {
  const originalFetch = globalThis.fetch
  const payloads = []
  globalThis.fetch = async (_url, init = {}) => {
    payloads.push(JSON.parse(String(init.body)))
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\n')); controller.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const tokens = { access_token: 'opaque', refresh_token: 'opaque', expires_in: 900, session_id: 'schemas', tier: 'lite', tier_label: 'Swico Lite', scopes: ['chat'], account: { email: 'test@example.com', name: 'Test' } }
    const env = { SWICO_API_BASE_URL: 'https://api.example.test' }
    await streamChat(tokens, 'return data', undefined, undefined, env, { outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false }, testTokenProvider: async () => tokens.access_token })
    await streamChat(tokens, 'return data', undefined, undefined, env, { outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } }, additionalProperties: false }, testTokenProvider: async () => tokens.access_token })
    assert.notDeepEqual(payloads[0].output_schema, payloads[1].output_schema)
    assert.equal(payloads[0].output_schema.required[0], 'answer')
    assert.equal(payloads[1].output_schema.required[0], 'count')
  } finally { globalThis.fetch = originalFetch }
})
