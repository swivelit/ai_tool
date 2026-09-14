import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSummary, loadConfig, validateMcpDefinition } from '../dist/configuration.js'
import { McpManager } from '../dist/mcp.js'
import { completion } from '../dist/completion.js'
import { listSkills, selectSkill } from '../dist/skills.js'
import { inspectPlugin } from '../dist/plugins.js'
import { probeEndpoint, streamChat } from '../dist/api.js'
import { parseTaskArguments, taskText } from '../dist/arguments.js'
import { loadOutputValidator, parseStructuredOutput, publishOutputAtomically } from '../dist/output_schema.js'

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

test('declarative plugin inspection rejects executable manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-plugin-'))
  try { await writeFile(join(root, 'swico-plugin.json'), JSON.stringify({ name: 'safe', version: '1.0.0', skills: ['review'] })); assert.equal((await inspectPlugin(root)).name, 'safe'); await writeFile(join(root, 'swico-plugin.json'), JSON.stringify({ name: 'bad', version: '1', main: 'index.js' })); await assert.rejects(() => inspectPlugin(root), /executable field/) } finally { await rm(root, { recursive: true, force: true }) }
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
