import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const cwd = fileURLToPath(new URL('..', import.meta.url))
const tokens = { access_token: 'access-a', refresh_token: 'refresh-a', expires_in: 900, session_id: 'session-a', tier: 'lite', tier_label: 'Swico Lite', scopes: ['chat'], account: { email: 'tester@example.test', name: 'Tester' } }
const credentialModule = await import('../dist/credentials.js')
const sessionModule = await import('../dist/session.js')
const configModule = await import('../dist/config.js')
const apiModule = await import('../dist/api.js')

function child(code, env) {
  return exec(process.execPath, ['--input-type=module', '-e', code], { cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 })
}

test('protected credential fallback survives a fresh CLI process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swico-credentials-'))
  const file = join(directory, 'credentials.json')
  const env = { SWICO_API_BASE_URL: 'https://api.example.test', SWICO_CLI_CREDENTIAL_FILE: file }
  try {
    const saved = await child(`import { saveTokens } from './dist/credentials.js'; console.log(await saveTokens(${JSON.stringify(tokens)}))`, env)
    assert.match(saved.stdout, /protected-file/)
    const loaded = await child(`import { loadTokens } from './dist/credentials.js'; console.log(JSON.stringify(await loadTokens()))`, env)
    assert.deepEqual(JSON.parse(loaded.stdout), tokens)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the reviewed native binding loads on the current platform', async () => {
  const keyring = await import('@napi-rs/keyring')
  assert.equal(typeof keyring.AsyncEntry, 'function')
})

test('production credential origin is HTTPS-only', () => {
  assert.equal(configModule.apiBaseUrl({}), 'https://ai-tool-rrau.onrender.com')
  assert.throws(() => configModule.apiBaseUrl({ SWICO_API_BASE_URL: 'http://api.example.test' }), /HTTPS/)
  assert.equal(configModule.apiBaseUrl({ SWICO_API_BASE_URL: 'http://127.0.0.1:8000', SWICO_CLI_ALLOW_INSECURE_LOCAL: '1' }), 'http://127.0.0.1:8000')
})

test('expired access token refreshes once and persists the rotated token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swico-refresh-'))
  const file = join(directory, 'credentials.json')
  const rotated = { ...tokens, access_token: 'access-b', refresh_token: 'refresh-b' }
  const calls = []
  const server = createServer((request, response) => {
    calls.push(request.url)
    if (request.url.endsWith('/me')) { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ detail: 'expired' })); return }
    if (request.url.endsWith('/token')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(rotated)); return }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const env = { SWICO_API_BASE_URL: `http://127.0.0.1:${port}`, SWICO_CLI_ALLOW_INSECURE_LOCAL: '1', SWICO_CLI_CREDENTIAL_FILE: file }
  try {
    await child(`import { saveTokens } from './dist/credentials.js'; await saveTokens(${JSON.stringify(tokens)})`, env)
    const result = await child(`import { ensureTokens } from './dist/session.js'; console.log(JSON.stringify(await ensureTokens()))`, env)
    assert.deepEqual(JSON.parse(result.stdout), rotated)
    assert.deepEqual(calls, ['/api/cli/v1/me', '/api/cli/v1/token'])
    const loaded = await child(`import { loadTokens } from './dist/credentials.js'; console.log(JSON.stringify(await loadTokens()))`, env)
    assert.deepEqual(JSON.parse(loaded.stdout), rotated)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('native credential lifecycle uses one origin-scoped secure-store record', async () => {
  const records = new Map()
  const calls = []
  const store = {
    storage: 'credential-manager',
    save(account, value) { calls.push(['save', account]); records.set(account, value) },
    load(account) { calls.push(['load', account]); return records.get(account) },
    delete(account) { calls.push(['delete', account]); return records.delete(account) },
  }
  const production = { SWICO_API_BASE_URL: 'https://api.example.test' }
  const development = { SWICO_API_BASE_URL: 'https://dev-api.example.test' }
  credentialModule.setNativeCredentialStoreForTests(store)
  try {
    assert.equal(await credentialModule.saveTokens(tokens, production), 'credential-manager')
    assert.deepEqual(await credentialModule.loadTokens(production), tokens)
    assert.equal(await credentialModule.saveTokens({ ...tokens, access_token: 'other-access' }, development), 'credential-manager')
    assert.equal((await credentialModule.loadTokens(development)).access_token, 'other-access')
    await credentialModule.clearTokens(production)
    assert.equal(await credentialModule.loadTokens(production), null)
    assert.equal((await credentialModule.loadTokens(development)).access_token, 'other-access')
    assert.deepEqual(calls.map(([kind]) => kind), ['save', 'save', 'delete', 'load'])
  } finally {
    await credentialModule.clearTokens(development)
    credentialModule.setNativeCredentialStoreForTests(null)
  }
})

test('native-store failure fails closed without exposing tokens', async () => {
  const secret = 'access-never-in-an-error'
  credentialModule.setNativeCredentialStoreForTests({
    storage: 'secret-service',
    save() { throw new Error(secret) },
    load() { return null },
    delete() { return false },
  })
  try {
    await assert.rejects(
      credentialModule.saveTokens({ ...tokens, access_token: secret }, { SWICO_API_BASE_URL: 'https://unavailable.example.test' }),
      error => error instanceof credentialModule.CredentialStorageUnavailableError && !String(error).includes(secret),
    )
  } finally { credentialModule.setNativeCredentialStoreForTests(null) }
})

test('malformed native JSON is rejected and logout clears the native record', async () => {
  const records = new Map()
  const store = {
    storage: 'keychain',
    save(account, value) { records.set(account, value) },
    load(account) { return records.get(account) },
    delete(account) { return records.delete(account) },
  }
  const env = { SWICO_API_BASE_URL: 'https://malformed.example.test' }
  credentialModule.setNativeCredentialStoreForTests(store)
  try {
    records.set(env.SWICO_API_BASE_URL, '{not-json')
    assert.equal(await credentialModule.loadTokens(env), null)
    await credentialModule.saveTokens(tokens, env)
    assert.deepEqual(await credentialModule.loadTokens(env), tokens)
    await credentialModule.clearTokens(env)
    assert.equal(records.size, 0)
  } finally { credentialModule.setNativeCredentialStoreForTests(null) }
})

test('rotating a memory-only session remains memory-only', async () => {
  const rotated = { ...tokens, access_token: 'memory-access-b', refresh_token: 'memory-refresh-b' }
  const server = createServer((request, response) => {
    if (request.url.endsWith('/me')) { response.writeHead(401); response.end('{}'); return }
    if (request.url.endsWith('/token')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(rotated)); return }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = { SWICO_API_BASE_URL: `http://127.0.0.1:${server.address().port}`, SWICO_CLI_ALLOW_INSECURE_LOCAL: '1' }
  try {
    await credentialModule.saveTokens(tokens, env, { memoryOnly: true })
    assert.equal(credentialModule.credentialStorageMode(env), 'memory')
    assert.deepEqual(await sessionModule.ensureTokens(env), rotated)
    assert.equal(credentialModule.credentialStorageMode(env), 'memory')
  } finally {
    await credentialModule.clearTokens(env)
    await new Promise(resolve => server.close(resolve))
  }
})

test('authenticated stream requests refresh current credentials and share one refresh operation', async () => {
  const rotated = { ...tokens, access_token: 'stream-access-b', refresh_token: 'stream-refresh-b' }
  const calls = []
  const server = createServer((request, response) => {
    calls.push({ path: request.url, authorization: request.headers.authorization })
    if (request.url.endsWith('/me')) { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{}'); return }
    if (request.url.endsWith('/token')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(rotated)); return }
    if (request.url.endsWith('/chat/stream')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('event: delta\ndata: {"text":"ready"}\n\nevent: done\ndata: {}\n\n')
      return
    }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = { SWICO_API_BASE_URL: `http://127.0.0.1:${server.address().port}`, SWICO_CLI_ALLOW_INSECURE_LOCAL: '1' }
  try {
    await credentialModule.saveTokens(tokens, env, { memoryOnly: true })
    await Promise.all([
      apiModule.streamChat(tokens, 'one', undefined, undefined, env),
      apiModule.streamChat(tokens, 'two', undefined, undefined, env),
    ])
    assert.equal(calls.filter(item => item.path.endsWith('/token')).length, 1)
    assert.equal(calls.filter(item => item.path.endsWith('/chat/stream')).length, 2)
    assert.ok(calls.filter(item => item.path.endsWith('/chat/stream')).every(item => item.authorization === `Bearer ${rotated.access_token}`))
  } finally {
    await credentialModule.clearTokens(env)
    await new Promise(resolve => server.close(resolve))
  }
})
