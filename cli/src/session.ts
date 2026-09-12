import { credentialKey } from './config.js'
import { loadTokens, saveTokens } from './credentials.js'
import { json, refresh } from './api.js'
import type { CliTokens } from './contracts.js'

const refreshLocks = new Map<string, Promise<CliTokens>>()

async function refreshStored(stored: CliTokens, env = process.env): Promise<CliTokens> {
  const lockKey = credentialKey(env)
  const existing = refreshLocks.get(lockKey)
  if (existing) return existing
  const operation = (async () => {
    const latest = await loadTokens(env)
    if (latest && latest.refresh_token !== stored.refresh_token) return latest
    const updated = await refresh(stored.refresh_token, env)
    await saveTokens(updated, env)
    return updated
  })()
  refreshLocks.set(lockKey, operation)
  try { return await operation } finally { if (refreshLocks.get(lockKey) === operation) refreshLocks.delete(lockKey) }
}

export async function ensureTokens(env = process.env): Promise<CliTokens> {
  const stored = await loadTokens(env)
  if (!stored) throw new Error('Sign in first with `swico login`.')
  try { await json('/me', {}, stored.access_token, env); return stored }
  catch (error) { if ((error as { status?: number }).status !== 401) throw error; return refreshStored(stored, env) }
}
