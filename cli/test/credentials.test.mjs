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
