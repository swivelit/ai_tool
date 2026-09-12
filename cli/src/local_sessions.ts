import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PlanItem } from './plan.js'

export type LocalSession = { id: string; run_id?: string; workspace_root: string; tier: string; mode: string; task?: string; plan: PlanItem[]; conversation_id?: string; actions: Array<{ action_id: string; payload_hash: string; status: string }>; updated_at: string }
const filename = () => process.env.SWICO_CLI_SESSIONS_FILE ?? join(homedir(), '.config', 'swico', 'sessions.json')

async function readAll(): Promise<LocalSession[]> {
  try { const value = JSON.parse(await readFile(filename(), 'utf8')); return Array.isArray(value) ? value : [] } catch { return [] }
}
async function writeAll(items: LocalSession[]): Promise<void> {
  const target = filename(), temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try { await writeFile(temporary, JSON.stringify(items.slice(0, 20)) + '\n', { mode: 0o600, flag: 'wx' }); await chmod(temporary, 0o600); await rename(temporary, target); await chmod(target, 0o600) }
  catch (error) { await import('node:fs/promises').then(fs => fs.unlink(temporary)).catch(() => undefined); throw error }
}
export async function saveLocalSession(session: LocalSession): Promise<void> { const items = await readAll(); const next = [session, ...items.filter(item => item.id !== session.id)]; await writeAll(next) }
export async function listLocalSessions(): Promise<LocalSession[]> { return readAll() }
export async function findLocalSession(id: string): Promise<LocalSession | null> { return (await readAll()).find(item => item.id === id) ?? null }
