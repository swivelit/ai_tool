import { credentialKey } from './config.js'
import { credentialStorageMode, loadTokens, saveTokens, type CredentialStorage } from './credentials.js'
import { json, refresh } from './api.js'
import type { CliTokens } from './contracts.js'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const refreshLocks = new Map<string, Promise<CliTokens>>()
const freshUntil = new Map<string, number>()

export class CredentialSessionChangedError extends Error {
  constructor() {
    super('The selected Swico session changed while its token was being refreshed. No other saved account was used.')
    this.name = 'CredentialSessionChangedError'
  }
}

function sessionKey(env: NodeJS.ProcessEnv, tokens: CliTokens, storage: CredentialStorage): string {
  return `${credentialKey(env)}|${storage}|${tokens.session_id}`
}

function refreshLockPath(env: NodeJS.ProcessEnv, tokens: CliTokens, storage: CredentialStorage): string {
  const digest = createHash('sha256').update(sessionKey(env, tokens, storage)).digest('hex').slice(0, 24)
  return join(env.SWICO_CLI_STATE_DIR ?? join(homedir(), '.config', 'swico'), `refresh-${digest}.lock`)
}

function freshnessInterval(tokens: CliTokens): number {
  // expires_in is a lifetime, not an issuance timestamp. A short local
  // freshness window avoids probing /me on every command without extending
  // the server-owned token lifetime.
  return Math.min(30_000, Math.max(1_000, Math.floor(Math.max(1, tokens.expires_in) * 500)))
}

function sameSession(left: CliTokens, right: CliTokens): boolean {
  return left.session_id === right.session_id
}

async function withRefreshFileLock<T>(env: NodeJS.ProcessEnv, stored: CliTokens, storage: CredentialStorage, task: () => Promise<T>): Promise<T> {
  const path = refreshLockPath(env, stored, storage)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 15_000
  while (true) {
    try { await writeFile(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Another Swico process is refreshing this session; retry shortly.')
      await new Promise(resolve => setTimeout(resolve, 100))
      const latest = await loadTokens(env, { bypassCache: true })
      if (latest && !sameSession(latest, stored)) throw new CredentialSessionChangedError()
      if (latest && latest.refresh_token !== stored.refresh_token) {
        freshUntil.set(sessionKey(env, latest, storage), Date.now() + freshnessInterval(latest))
        return latest as T
      }
    }
  }
  try { return await task() } finally { await unlink(path).catch(() => undefined) }
}

async function refreshStored(stored: CliTokens, env = process.env): Promise<CliTokens> {
  const storage = credentialStorageMode(env) ?? 'memory'
  const lockKey = sessionKey(env, stored, storage)
  const existing = refreshLocks.get(lockKey)
  if (existing) return existing
  const operation = (async () => {
    const task = async () => {
      // A memory-only selection is process-local by design. Reading the
      // native store here would turn an intentional account switch into an
      // unrelated durable account adoption.
      if (storage === 'memory') {
        const selected = await loadTokens(env)
        if (!selected || !sameSession(selected, stored)) throw new CredentialSessionChangedError()
        if (selected.refresh_token !== stored.refresh_token) return selected
      } else {
        const latest = await loadTokens(env, { bypassCache: true })
        if (latest && !sameSession(latest, stored)) throw new CredentialSessionChangedError()
        if (latest && latest.refresh_token !== stored.refresh_token) {
          freshUntil.set(sessionKey(env, latest, storage), Date.now() + freshnessInterval(latest))
          return latest
        }
      }
      const updated = await refresh(stored.refresh_token, env)
      if (!sameSession(updated, stored)) throw new CredentialSessionChangedError()
      const selectedAfterRefresh = await loadTokens(env)
      if (!selectedAfterRefresh || !sameSession(selectedAfterRefresh, stored)) throw new CredentialSessionChangedError()
      // Keep the storage selected when this session was created. In
      // particular, a --memory-only session must not become durable.
      await saveTokens(updated, env, { memoryOnly: storage === 'memory' })
      freshUntil.set(sessionKey(env, updated, storage), Date.now() + freshnessInterval(updated))
      return updated
    }
    return storage === 'memory' ? task() : withRefreshFileLock(env, stored, storage, task)
  })()
  refreshLocks.set(lockKey, operation)
  try { return await operation } finally { if (refreshLocks.get(lockKey) === operation) refreshLocks.delete(lockKey) }
}

export async function ensureTokens(env = process.env): Promise<CliTokens> {
  const stored = await loadTokens(env)
  if (!stored) throw new Error('Sign in first with `swico login`.')
  const storage = credentialStorageMode(env) ?? 'memory'
  const key = sessionKey(env, stored, storage), expiry = freshUntil.get(key)
  if (expiry && expiry > Date.now()) return stored
  try {
    await json('/me', {}, stored.access_token, env)
    // A token loaded in a new process has no local issuance timestamp. Treat
    // it as briefly fresh, then rotate it before the next operation rather
    // than trusting the persisted expires_in as an issuance timestamp.
    freshUntil.set(key, Date.now() + freshnessInterval(stored))
    return stored
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error
    return refreshStored(stored, env)
  }
}
