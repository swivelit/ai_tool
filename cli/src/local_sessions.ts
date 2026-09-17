import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { PlanItem } from './plan.js'

export type LocalSession = {
  id: string
  run_id?: string
  workspace_root: string
  workspace_key?: string
  account_key?: string
  title?: string
  archived?: boolean
  parent_id?: string
  compaction?: { summary: string; preserved_observations: number; at: string }
  observations?: string[]
  tier: string
  mode: string
  task?: string
  plan: PlanItem[]
  conversation_id?: string
  actions: Array<{ action_id: string; payload_hash: string; status: string }>
  updated_at: string
}

const filename = (env: NodeJS.ProcessEnv = process.env) => env.SWICO_CLI_SESSIONS_FILE ?? join(homedir(), '.config', 'swico', 'sessions.json')
const validId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const pendingWrites = new Map<string, Promise<void>>()

export function sessionScope(accountEmail: string | null | undefined, workspaceRoot: string): { account_key: string; workspace_key: string } {
  const account = (accountEmail ?? '').trim().toLocaleLowerCase() || 'unknown-account'
  return {
    account_key: createHash('sha256').update(account).digest('hex'),
    workspace_key: createHash('sha256').update(resolve(workspaceRoot)).digest('hex'),
  }
}

async function readAll(env: NodeJS.ProcessEnv = process.env): Promise<LocalSession[]> {
  try {
    const value = JSON.parse(await readFile(filename(env), 'utf8'))
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object').slice(0, 100) as LocalSession[] : []
  } catch { return [] }
}

async function withWriteLock<T>(env: NodeJS.ProcessEnv, operation: () => Promise<T>): Promise<T> {
  const target = filename(env), previous = pendingWrites.get(target) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolveCurrent => { release = resolveCurrent })
  pendingWrites.set(target, current)
  await previous
  try { return await operation() } finally {
    release()
    if (pendingWrites.get(target) === current) pendingWrites.delete(target)
  }
}

async function writeAllUnlocked(items: LocalSession[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = filename(env)
  const temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, JSON.stringify(items.slice(0, 100)) + '\n', { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, target)
    await chmod(target, 0o600)
  } catch (error) {
    await import('node:fs/promises').then(fs => fs.unlink(temporary)).catch(() => undefined)
    throw error
  }
}

function inScope(item: LocalSession, scope?: { account_key: string; workspace_key: string }): boolean {
  return !scope || (item.account_key === scope.account_key && item.workspace_key === scope.workspace_key)
}

export async function saveLocalSession(session: LocalSession, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!validId.test(session.id)) throw new Error('Local session ID is invalid.')
  await withWriteLock(env, async () => {
    const items = await readAll(env), next = [session, ...items.filter(item => item.id !== session.id)]
    await writeAllUnlocked(next, env)
  })
}

export async function listLocalSessions(scope?: { account_key: string; workspace_key: string }, env: NodeJS.ProcessEnv = process.env): Promise<LocalSession[]> {
  return (await readAll(env)).filter(item => inScope(item, scope) && item.archived !== true)
}

export async function findLocalSession(id: string, scope?: { account_key: string; workspace_key: string }, env: NodeJS.ProcessEnv = process.env): Promise<LocalSession | null> {
  if (!validId.test(id)) return null
  return (await readAll(env)).find(item => item.id === id && inScope(item, scope) && item.archived !== true) ?? null
}

export async function updateLocalSession(id: string, scope: { account_key: string; workspace_key: string }, changes: Partial<Pick<LocalSession, 'title' | 'archived' | 'compaction' | 'observations' | 'updated_at'>>, env: NodeJS.ProcessEnv = process.env): Promise<LocalSession> {
  return withWriteLock(env, async () => {
    const items = await readAll(env), index = items.findIndex(item => item.id === id && inScope(item, scope))
    if (index < 0) throw new Error('Local session not found in this account and workspace.')
    const next = { ...items[index], ...changes, updated_at: changes.updated_at ?? new Date().toISOString() }
    items[index] = next; await writeAllUnlocked(items, env); return next
  })
}

export async function removeLocalSession(id: string, scope: { account_key: string; workspace_key: string }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await withWriteLock(env, async () => {
    const items = await readAll(env), index = items.findIndex(item => item.id === id && inScope(item, scope))
    if (index < 0) throw new Error('Local session not found in this account and workspace.')
    items.splice(index, 1); await writeAllUnlocked(items, env)
  })
}

export async function forkLocalSession(id: string, scope: { account_key: string; workspace_key: string }, env: NodeJS.ProcessEnv = process.env): Promise<LocalSession> {
  const source = await findLocalSession(id, scope, env)
  if (!source) throw new Error('Local session not found in this account and workspace.')
  const fork: LocalSession = {
    ...source,
    id: randomUUID(),
    run_id: undefined,
    parent_id: source.id,
    title: `${source.title ?? source.task ?? 'Session'} (fork)`.slice(0, 160),
    archived: false,
    plan: source.plan.map(item => ({ ...item })),
    compaction: source.compaction ? { ...source.compaction } : undefined,
    observations: source.observations ? [...source.observations] : [],
    actions: [],
    updated_at: new Date().toISOString(),
  }
  await saveLocalSession(fork, env); return fork
}

export async function compactLocalSession(id: string, scope: { account_key: string; workspace_key: string }, env: NodeJS.ProcessEnv = process.env): Promise<LocalSession> {
  const source = await findLocalSession(id, scope, env)
  if (!source) throw new Error('Local session not found in this account and workspace.')
  const observations = (source.observations ?? []).map(item => item.slice(0, 4_000))
  const keep = Math.min(8, observations.length)
  const summary = [source.task ? `Task: ${source.task}` : '', `Plan: ${source.plan.filter(item => item.state !== 'pending').map(item => item.description).slice(-8).join('; ') || 'No completed plan items recorded.'}`, `Recent tool outcomes: ${observations.slice(-keep).join(' | ') || 'None recorded.'}`, 'Safety boundary: Pending executable approvals, reservations, and replayable actions are not carried by compaction.'].filter(Boolean).join('\n').slice(0, 8_000)
  return updateLocalSession(id, scope, { observations: observations.slice(-keep), compaction: { summary, preserved_observations: keep, at: new Date().toISOString() } }, env)
}
