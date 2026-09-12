import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CliTokens } from './contracts.js'
import { credentialKey } from './config.js'

const SERVICE_NAME = 'swico-cli'
const memory = new Map<string, { tokens: CliTokens; storage: CredentialStorage }>()

export type CredentialStorage = 'keychain' | 'credential-manager' | 'secret-service' | 'protected-file' | 'memory'
type NativeStorage = Exclude<CredentialStorage, 'protected-file' | 'memory'>

export type NativeCredentialStore = {
  storage: NativeStorage
  save(account: string, value: string): void | Promise<void>
  load(account: string): string | null | undefined | Promise<string | null | undefined>
  delete(account: string): boolean | void | Promise<boolean | void>
}

let nativeStoreOverride: NativeCredentialStore | null | undefined

function key(env = process.env) { return credentialKey(env) }
function filePath(env = process.env) { return env.SWICO_CLI_CREDENTIAL_FILE ?? join(homedir(), '.config', 'swico', 'credentials.json') }

export class CredentialStorageUnavailableError extends Error {
  constructor() {
    super('No supported OS credential store is available. Set SWICO_CLI_CREDENTIAL_FILE to an explicit protected path, or use --memory-only for a non-persistent session.')
    this.name = 'CredentialStorageUnavailableError'
  }
}

function storageForPlatform(): NativeStorage | null {
  if (process.platform === 'darwin') return 'keychain'
  if (process.platform === 'win32') return 'credential-manager'
  if (process.platform === 'linux') return 'secret-service'
  return null
}

/** Test seam for exercising the production storage lifecycle without a desktop keyring. */
export function setNativeCredentialStoreForTests(store: NativeCredentialStore | null): void {
  nativeStoreOverride = store
}

async function nativeStore(): Promise<NativeCredentialStore | null> {
  if (nativeStoreOverride !== undefined) return nativeStoreOverride
  const storage = storageForPlatform()
  if (!storage) return null
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring')
    return {
      storage,
      save: (account, value) => new AsyncEntry(SERVICE_NAME, account).setPassword(value),
      load: account => new AsyncEntry(SERVICE_NAME, account).getPassword(),
      delete: account => new AsyncEntry(SERVICE_NAME, account).deletePassword(),
    }
  } catch {
    // Missing optional native bindings and an unavailable desktop service are
    // deliberately indistinguishable to callers: both fail closed.
    return null
  }
}

function validTokens(value: unknown): value is CliTokens {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<CliTokens>
  return typeof candidate.access_token === 'string' && candidate.access_token.length > 0
    && typeof candidate.refresh_token === 'string' && candidate.refresh_token.length > 0
    && typeof candidate.expires_in === 'number' && typeof candidate.session_id === 'string'
    && (candidate.tier === 'free' || candidate.tier === 'lite' || candidate.tier === 'standard' || candidate.tier === 'pro')
    && typeof candidate.tier_label === 'string' && Array.isArray(candidate.scopes)
    && !!candidate.account && typeof candidate.account === 'object'
}

function parseStored(value: string | null | undefined): CliTokens | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return validTokens(parsed) ? parsed : null
  } catch { return null }
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
      // Only the path/account are passed to icacls; credential JSON never is.
      const { execFile } = await import('node:child_process')
      await new Promise<void>((resolve, reject) => execFile('icacls', [temporary, '/inheritance:r', '/grant:r', `${account}:(R,W)`], { windowsHide: true }, error => error ? reject(error) : resolve()))
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
  const account = key(env)
  let storage: CredentialStorage | null = null
  if (!options.memoryOnly) {
    // An explicit path is a deliberate advanced fallback and takes precedence
    // over native storage. It is never selected implicitly.
    if (env.SWICO_CLI_CREDENTIAL_FILE) storage = await saveProtectedFile(tokens, env).catch(() => null)
    else {
      const store = await nativeStore()
      if (store) {
        try {
          await store.save(account, JSON.stringify(tokens))
          storage = store.storage
        } catch { storage = null }
      }
    }
  }
  if (!storage && !options.memoryOnly) throw new CredentialStorageUnavailableError()
  storage ??= 'memory'
  memory.set(account, { tokens, storage })
  return storage
}

export function credentialStorageMode(env = process.env): CredentialStorage | null {
  return memory.get(key(env))?.storage ?? null
}

export async function loadTokens(env = process.env): Promise<CliTokens | null> {
  const account = key(env)
  const cached = memory.get(account)
  if (cached) return cached.tokens

  if (env.SWICO_CLI_CREDENTIAL_FILE) {
    try {
      const value = JSON.parse(await readFile(filePath(env), 'utf8')) as { endpoint?: string; tokens?: unknown }
      if (value.endpoint !== account || !validTokens(value.tokens)) return null
      memory.set(account, { tokens: value.tokens, storage: 'protected-file' })
      return value.tokens
    } catch { return null }
  }

  const store = await nativeStore()
  if (!store) return null
  try {
    const tokens = parseStored(await store.load(account))
    if (!tokens) return null
    memory.set(account, { tokens, storage: store.storage })
    return tokens
  } catch { return null }
}

export async function clearTokens(env = process.env): Promise<void> {
  const account = key(env)
  const cached = memory.get(account)
  memory.delete(account)
  if (env.SWICO_CLI_CREDENTIAL_FILE) {
    await unlink(filePath(env)).catch(() => undefined)
    return
  }
  // Logout must remove the native credential. A missing store is harmless,
  // but an actual delete failure is surfaced rather than claiming success.
  if (cached?.storage === 'memory') return
  const store = await nativeStore()
  if (store) {
    try { await store.delete(account) }
    catch (error) {
      // With no loaded credential there is no evidence that a native record
      // exists; keep logout idempotent. A known loaded record must surface a
      // deletion failure so logout cannot claim it was removed.
      if (cached) throw error
    }
  }
}

export function credentialStorageDescription(env = process.env): string {
  let endpoint: string
  try { endpoint = key(env) } catch { return 'unavailable (invalid endpoint)' }
  const cached = memory.get(endpoint)
  if (cached?.storage === 'memory') return 'memory-only (this process)'
  if (env.SWICO_CLI_CREDENTIAL_FILE) return 'explicit protected file (used if the path is writable)'
  if (process.platform === 'darwin') return 'macOS Keychain (native keyring)'
  if (process.platform === 'win32') return 'Windows Credential Manager (native keyring)'
  if (process.platform === 'linux') return 'Linux Secret Service (native keyring)'
  return 'no automatic OS store; explicit protected fallback required'
}
