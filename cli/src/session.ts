import { credentialKey } from './config.js'
import { credentialStorageMode, loadTokens, saveTokens } from './credentials.js'
import { json, refresh } from './api.js'
import type { CliTokens } from './contracts.js'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const refreshLocks = new Map<string, Promise<CliTokens>>()
const freshUntil = new Map<string, number>()

function refreshLockPath(env = process.env): string {
  const digest = createHash('sha256').update(credentialKey(env)).digest('hex').slice(0, 24)
  return join(env.SWICO_CLI_STATE_DIR ?? join(homedir(), '.config', 'swico'), `refresh-${digest}.lock`)
}

async function withRefreshFileLock<T>(env: NodeJS.ProcessEnv, previousRefreshToken: string, task: () => Promise<T>): Promise<T> {
  const path = refreshLockPath(env)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 15_000
  while (true) {
    try { await writeFile(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Another Swico process is refreshing this session; retry shortly.')
      await new Promise(resolve => setTimeout(resolve, 100))
      const latest = await loadTokens(env, { bypassCache: true })
      if (latest && latest.refresh_token !== previousRefreshToken) {
        freshUntil.set(credentialKey(env), Date.now() + Math.min(30_000, Math.max(1, latest.expires_in) * 1000))
        return latest as T
      }
    }
  }
  try { return await task() } finally { await unlink(path).catch(() => undefined) }
}

async function refreshStored(stored: CliTokens, env = process.env): Promise<CliTokens> {
  const lockKey = credentialKey(env)
  const existing = refreshLocks.get(lockKey)
  if (existing) return existing
  const operation = (async () => {
    return withRefreshFileLock(env, stored.refresh_token, async () => {
      const latest = await loadTokens(env, { bypassCache: true })
      if (latest && latest.refresh_token !== stored.refresh_token) return latest
      const updated = await refresh(stored.refresh_token, env)
      // Keep the storage selected when the session was created. In particular,
      // a --memory-only session must not become durable during rotation.
      await saveTokens(updated, env, { memoryOnly: credentialStorageMode(env) === 'memory' })
      freshUntil.set(lockKey, Date.now() + Math.max(1, updated.expires_in) * 1000)
      return updated
    })
  })()
  refreshLocks.set(lockKey, operation)
  try { return await operation } finally { if (refreshLocks.get(lockKey) === operation) refreshLocks.delete(lockKey) }
}

export async function ensureTokens(env = process.env): Promise<CliTokens> {
  const stored = await loadTokens(env)
  if (!stored) throw new Error('Sign in first with `swico login`.')
  const key = credentialKey(env), expiry = freshUntil.get(key)
  if (expiry && expiry > Date.now() + 30_000) return stored
  try {
    await json('/me', {}, stored.access_token, env)
    // A token loaded in a new process has no local issuance timestamp. Treat
    // it as briefly fresh, then rotate it before the next operation rather
    // than trusting the persisted expires_in as an issuance timestamp.
    freshUntil.set(key, Date.now() + Math.min(30_000, Math.max(1, stored.expires_in) * 1000))
    return stored
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error
    return refreshStored(stored, env)
  }
}
