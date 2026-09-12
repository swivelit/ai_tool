import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CliTokens } from './contracts.js'
import { credentialKey } from './config.js'

const memory = new Map<string, CliTokens>()
const exec = promisify(execFile)
const STORE_TIMEOUT_MS = 2_000
function key(env = process.env) { return credentialKey(env) }
function filePath(env = process.env) { return env.SWICO_CLI_CREDENTIAL_FILE ?? join(homedir(), '.config', 'swico', 'credentials.json') }

export type CredentialStorage = 'keychain' | 'secret-service' | 'protected-file' | 'memory'
export class CredentialStorageUnavailableError extends Error {
  constructor() { super('No supported OS credential store is available. Set SWICO_CLI_CREDENTIAL_FILE to an explicit protected path, or use --memory-only for a non-persistent session.') }
}

async function command(name: string, args: string[], options: { input?: string } = {}) {
  return exec(name, args, { ...options, timeout: STORE_TIMEOUT_MS, windowsHide: true })
}

async function saveOsStore(value: string, env: NodeJS.ProcessEnv): Promise<CredentialStorage | null> {
  if (process.platform === 'darwin') {
    await command('security', ['add-generic-password', '-U', '-s', `swico-cli:${key(env)}`, '-a', key(env), '-w', value])
    return 'keychain'
  }
  if (process.platform === 'linux') {
    await command('secret-tool', ['store', '--label=Swico CLI', 'service', 'swico-cli', 'endpoint', key(env)], { input: value })
    return 'secret-service'
  }
  return null
}

async function loadOsStore(env: NodeJS.ProcessEnv): Promise<{ tokens: CliTokens; storage: CredentialStorage } | null> {
  try {
    let value = ''
    let storage: CredentialStorage
    if (process.platform === 'darwin') {
      value = (await command('security', ['find-generic-password', '-s', `swico-cli:${key(env)}`, '-a', key(env), '-w'])).stdout
      storage = 'keychain'
    } else if (process.platform === 'linux') {
      value = (await command('secret-tool', ['lookup', 'service', 'swico-cli', 'endpoint', key(env)])).stdout
      storage = 'secret-service'
    } else return null
    const tokens = JSON.parse(value.trim()) as CliTokens
    if (tokens.access_token && tokens.refresh_token) return { tokens, storage }
  } catch { /* an unavailable/unconfigured store is handled by the caller */ }
  return null
}

async function saveProtectedFile(tokens: CliTokens, env: NodeJS.ProcessEnv) {
  const target = env.SWICO_CLI_CREDENTIAL_FILE
  if (!target) return null
  const directory = dirname(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ endpoint: key(env), tokens }) + '\n', { mode: 0o600, flag: 'wx' })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    if (process.platform === 'win32') {
      const account = env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME
      if (!account) throw new Error('Windows user identity is unavailable for credential-file ACL protection.')
      await command('icacls', [temporary, '/inheritance:r', '/grant:r', `${account}:(R,W)`])
    }
    await rename(temporary, target)
    if (process.platform !== 'win32') await chmod(target, 0o600)
    return 'protected-file' as const
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function saveTokens(tokens: CliTokens, env = process.env, options: { memoryOnly?: boolean } = {}): Promise<CredentialStorage> {
  let storage: CredentialStorage | null = null
  if (!options.memoryOnly) {
    // An explicitly selected file is the user's deliberate fallback and
    // avoids probing a desktop keychain that may block on a headless host.
    if (env.SWICO_CLI_CREDENTIAL_FILE) storage = await saveProtectedFile(tokens, env).catch(() => null)
    else {
      try { storage = await saveOsStore(JSON.stringify(tokens), env) } catch { /* report unavailable below */ }
    }
  }
  if (!storage && !options.memoryOnly) throw new CredentialStorageUnavailableError()
  storage ??= 'memory'
  memory.set(key(env), tokens)
  return storage
}
export async function loadTokens(env = process.env): Promise<CliTokens | null> {
  const found = memory.get(key(env)); if (found) return found
  const osValue = env.SWICO_CLI_CREDENTIAL_FILE ? null : await loadOsStore(env)
  if (osValue) { memory.set(key(env), osValue.tokens); return osValue.tokens }
  if (!env.SWICO_CLI_CREDENTIAL_FILE) return null
  try {
    const value = JSON.parse(await readFile(filePath(env), 'utf8')) as { endpoint?: string; tokens?: CliTokens }
    if (value.endpoint !== key(env) || !value.tokens?.access_token || !value.tokens.refresh_token) return null
    memory.set(key(env), value.tokens)
    return value.tokens
  } catch { return null }
}
export async function clearTokens(env = process.env): Promise<void> {
  memory.delete(key(env))
  if (process.platform === 'darwin') await command('security', ['delete-generic-password', '-s', `swico-cli:${key(env)}`, '-a', key(env)]).catch(() => undefined)
  if (process.platform === 'linux') await command('secret-tool', ['clear', 'service', 'swico-cli', 'endpoint', key(env)]).catch(() => undefined)
  if (env.SWICO_CLI_CREDENTIAL_FILE) await unlink(filePath(env)).catch(() => undefined)
}

export function credentialStorageDescription(env = process.env): string {
  let endpoint: string
  try { endpoint = key(env) } catch { return 'unavailable (invalid endpoint)' }
  if (memory.has(endpoint)) return 'memory-only (this process)'
  if (env.SWICO_CLI_CREDENTIAL_FILE) return 'explicit protected file (used if the path is writable)'
  if (process.platform === 'darwin') return 'macOS Keychain'
  if (process.platform === 'linux') return 'Linux Secret Service (secret-tool)'
  return 'no automatic OS store; explicit protected fallback required'
}
