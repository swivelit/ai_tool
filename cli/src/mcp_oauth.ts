import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { URL } from 'node:url'

export type McpOAuthToken = { access_token: string; token_type: string; expires_at: number; refresh_token?: string; scope?: string; issuer: string; server_origin: string; client_id: string; token_endpoint: string; revocation_endpoint?: string }
type OAuthMetadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; revocation_endpoint?: string; code_challenge_methods_supported?: string[]; scopes_supported?: string[] }
const MAX_RESPONSE = 64 * 1024
const OAUTH_TIMEOUT_MS = 15_000

function storePath(serverUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash('sha256').update(serverUrl).digest('hex').slice(0, 32)
  return env.SWICO_CLI_MCP_TOKEN_FILE ? `${env.SWICO_CLI_MCP_TOKEN_FILE}.${digest}` : join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'swico', 'mcp-oauth', `${digest}.json`)
}
function originOf(value: string): string {
  const parsed = new URL(value)
  if (parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('MCP OAuth destination contains credentials or query data.')
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  const hostname = parsed.hostname.toLowerCase(), numeric = isIP(hostname)
  const privateIpv4 = numeric === 4 && (/^(10|127)\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) || /^169\.254\./.test(hostname))
  const privateName = hostname === 'metadata' || hostname === 'metadata.google.internal' || hostname.endsWith('.local')
  if ((privateIpv4 || privateName || (numeric === 6 && hostname !== '::1')) && !local) throw new Error('MCP OAuth destination is a private or link-local address.')
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('MCP OAuth requires HTTPS except for loopback development callbacks.')
  return parsed.origin
}
function safeEndpoint(value: unknown, expectedOrigin: string): string {
  if (typeof value !== 'string') throw new Error('MCP OAuth metadata is incomplete.')
  const endpointOrigin = originOf(value)
  if (endpointOrigin !== expectedOrigin) throw new Error('MCP OAuth endpoint changed server identity.')
  return value
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  let text = ''
  if (response.body) {
    const reader = response.body.getReader(); const decoder = new TextDecoder()
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) { text += decoder.decode(); break }
        text += decoder.decode(next.value, { stream: true })
        if (Buffer.byteLength(text) > MAX_RESPONSE) { await reader.cancel(); throw new Error('MCP OAuth response exceeds the supported bound.') }
      }
    } finally { reader.releaseLock() }
  } else text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE) throw new Error('MCP OAuth response exceeds the supported bound.')
  const value = JSON.parse(text) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP OAuth response is malformed.')
  return value as Record<string, unknown>
}
async function metadata(serverUrl: string, signal?: AbortSignal): Promise<OAuthMetadata> {
  const origin = originOf(serverUrl)
  const requestSignal = signal ?? AbortSignal.timeout(OAUTH_TIMEOUT_MS)
  let response = await fetch(`${origin}/.well-known/oauth-authorization-server`, { redirect: 'error', signal: requestSignal })
  if (response.status === 404) response = await fetch(`${origin}/.well-known/openid-configuration`, { redirect: 'error', signal: requestSignal })
  if (!response.ok) throw new Error('MCP server does not publish supported OAuth metadata.')
  const value = await boundedJson(response)
  const issuer = safeEndpoint(value.issuer, origin)
  const authorization_endpoint = safeEndpoint(value.authorization_endpoint, origin)
  const token_endpoint = safeEndpoint(value.token_endpoint, origin)
  if (value.code_challenge_methods_supported && !(value.code_challenge_methods_supported as unknown[]).includes('S256')) throw new Error('MCP OAuth server does not support PKCE S256.')
  return { issuer, authorization_endpoint, token_endpoint, revocation_endpoint: value.revocation_endpoint ? safeEndpoint(value.revocation_endpoint, origin) : undefined, code_challenge_methods_supported: value.code_challenge_methods_supported as string[] | undefined, scopes_supported: value.scopes_supported as string[] | undefined }
}
async function save(serverUrl: string, token: McpOAuthToken, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = storePath(serverUrl, env); const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(temporary, JSON.stringify(token) + '\n', { mode: 0o600, flag: 'wx' }); await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600)
}
async function load(serverUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<McpOAuthToken | null> {
  try { const value = JSON.parse(await readFile(storePath(serverUrl, env), 'utf8')) as McpOAuthToken; return value && typeof value.access_token === 'string' && typeof value.issuer === 'string' && value.server_origin === originOf(serverUrl) ? value : null } catch { return null }
}
export async function logoutMcpOAuth(serverUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const token = await load(serverUrl, env)
  if (token?.revocation_endpoint && token.refresh_token) { await fetch(token.revocation_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.refresh_token, token_type_hint: 'refresh_token', client_id: token.client_id }) }).catch(() => undefined) }
  await unlink(storePath(serverUrl, env)).catch(() => undefined)
}
export async function mcpOAuthStatus(serverUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<{ configured: boolean; expires_at?: number; issuer?: string }> { const token = await load(serverUrl, env); return token ? { configured: true, expires_at: token.expires_at, issuer: token.issuer } : { configured: false } }
export async function mcpAuthorizationHeader(serverUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const token = await load(serverUrl, env); if (!token) return undefined
  if (token.expires_at > Math.floor(Date.now() / 1000) + 30) return `${token.token_type || 'Bearer'} ${token.access_token}`
  if (!token.refresh_token) return undefined
  const response = await fetch(token.token_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: token.client_id }) })
  if (!response.ok) { await logoutMcpOAuth(serverUrl, env); return undefined }
  const value = await boundedJson(response); if (typeof value.access_token !== 'string') throw new Error('MCP OAuth refresh response is invalid.')
  const refreshed: McpOAuthToken = { ...token, access_token: value.access_token, token_type: typeof value.token_type === 'string' ? value.token_type : token.token_type, expires_at: Math.floor(Date.now() / 1000) + Math.max(30, Number(value.expires_in ?? 300)), refresh_token: typeof value.refresh_token === 'string' ? value.refresh_token : token.refresh_token }
  await save(serverUrl, refreshed, env); return `${refreshed.token_type || 'Bearer'} ${refreshed.access_token}`
}
export async function loginMcpOAuth(serverUrl: string, clientId: string, scope = 'mcp', env: NodeJS.ProcessEnv = process.env, output: (line: string) => void = console.log): Promise<void> {
  if (!clientId || !/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) throw new Error('MCP OAuth client ID must be explicitly configured and bounded.')
  const details = await metadata(serverUrl); if (details.scopes_supported && !scope.split(/\s+/).every(item => details.scopes_supported?.includes(item))) throw new Error('Requested MCP OAuth scope is not supported by this server.')
  const state = randomBytes(24).toString('base64url'), verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url')
  let finishCallback: (() => void) | undefined
  const callbackServer = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/mcp-oauth-callback' || url.searchParams.get('state') !== state) throw new Error('MCP OAuth callback state did not match.')
      const code = url.searchParams.get('code'); if (!code) throw new Error('MCP OAuth callback did not contain an authorization code.')
      response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Swico MCP authorization received. You may close this window.')
      callbackResolve({ code, redirect }); finishCallback?.()
    } catch (error) {
      response.writeHead(400); response.end('Swico MCP authorization was rejected.'); callbackReject(error); finishCallback?.()
    }
  })
  let callbackResolve!: (value: { code: string; redirect: string }) => void
  let callbackReject!: (reason?: unknown) => void
  const callbackCode = new Promise<{ code: string; redirect: string }>((resolve, reject) => { callbackResolve = resolve; callbackReject = reject })
  const redirect = await new Promise<string>((resolve, reject) => {
    callbackServer.once('error', reject)
    callbackServer.listen(0, '127.0.0.1', () => {
      const address = callbackServer.address()
      if (!address || typeof address === 'string') { reject(new Error('MCP OAuth callback listener did not expose a local port.')); return }
      resolve(`http://127.0.0.1:${address.port}/mcp-oauth-callback`)
    })
  })
  finishCallback = () => callbackServer.close()
  try {
    const authorization = new URL(details.authorization_endpoint); authorization.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString(); output(`Open this MCP authorization URL in your browser:\n${authorization}`)
    const callback = await callbackCode
    const tokenResponse = await fetch(details.token_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.code, client_id: clientId, redirect_uri: callback.redirect, code_verifier: verifier }) })
    if (!tokenResponse.ok) throw new Error('MCP OAuth token exchange failed.')
    const value = await boundedJson(tokenResponse); if (typeof value.access_token !== 'string') throw new Error('MCP OAuth token response is invalid.')
    await save(serverUrl, { access_token: value.access_token, token_type: typeof value.token_type === 'string' ? value.token_type : 'Bearer', expires_at: Math.floor(Date.now() / 1000) + Math.max(30, Number(value.expires_in ?? 300)), refresh_token: typeof value.refresh_token === 'string' ? value.refresh_token : undefined, scope: typeof value.scope === 'string' ? value.scope : scope, issuer: details.issuer, server_origin: originOf(serverUrl), client_id: clientId, token_endpoint: details.token_endpoint, revocation_endpoint: details.revocation_endpoint }, env)
  } finally { if (callbackServer.listening) callbackServer.close() }
}
