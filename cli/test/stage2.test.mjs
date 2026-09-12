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
import { streamChat } from '../dist/api.js'

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
    const manager = new McpManager({ source: 'user', path: '', searchMode: 'auto', defaultMode: 'auto', autoSkills: true, hooksEnabled: false, mcp: [definition] }, join(root, 'journal.jsonl'))
    const tools = await manager.discover('fake')
    assert.deepEqual(tools.map(item => [item.name, item.capability]), [['echo', 'read'], ['write_note', 'unknown']])
    assert.equal(await manager.call('fake', 'echo', { value: 'ok' }, async () => false), '[{"type":"text","text":"ok"}]')
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
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('declarative plugin inspection rejects executable manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-plugin-'))
  try { await writeFile(join(root, 'swico-plugin.json'), JSON.stringify({ name: 'safe', version: '1.0.0', skills: ['review'] })); assert.equal((await inspectPlugin(root)).name, 'safe'); await writeFile(join(root, 'swico-plugin.json'), JSON.stringify({ name: 'bad', version: '1', main: 'index.js' })); await assert.rejects(() => inspectPlugin(root), /executable field/) } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI chat carries server-controlled search mode and temporary attachments through the real stream client', async () => {
  const originalFetch = globalThis.fetch; let payload
  globalThis.fetch = async (_url, init = {}) => { payload = JSON.parse(String(init.body)); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: thread\ndata: {"thread_id":"t1"}\n\nevent: delta\ndata: {"text":"ok"}\n\nevent: done\ndata: {}\n\n')); controller.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }) }
  try {
    const tokens = { access_token: 'opaque', refresh_token: 'opaque', expires_in: 900, session_id: 's', tier: 'lite', tier_label: 'Swico Lite', scopes: ['chat'], account: { email: 'test@example.com', name: 'Test' } }
    const answer = await streamChat(tokens, 'latest status', undefined, undefined, { SWICO_API_BASE_URL: 'https://api.example.test' }, { searchMode: 'on', attachmentIds: ['upload-1'] })
    assert.equal(answer.text, 'ok'); assert.deepEqual(payload.attachment_ids, ['upload-1']); assert.equal(payload.search_mode, 'on')
  } finally { globalThis.fetch = originalFetch }
})
