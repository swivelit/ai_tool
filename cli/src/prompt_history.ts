import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const MAX_PROMPTS = 200
const MAX_PROMPT = 4_000
const sensitive = /(?:password|passwd|secret|token|api[_-]?key|authorization|bearer)\s*[:=]/i

function file(env: NodeJS.ProcessEnv = process.env): string { return env.SWICO_CLI_HISTORY_FILE ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'swico', 'prompt-history.json') }
function scope(account: string | null | undefined, workspace: string): string { return createHash('sha256').update(`${(account ?? 'unknown').trim().toLocaleLowerCase()}\n${resolve(workspace)}`).digest('hex') }
function safePrompt(value: string): string | null {
  const text = value.trim()
  if (!text || text.length > MAX_PROMPT || sensitive.test(text) || /Bearer\s+[A-Za-z0-9._-]{16,}/i.test(text)) return null
  return text
}

export async function loadPromptHistory(account: string | null | undefined, workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(file(env), 'utf8'))
    return Array.isArray(value) ? value.filter(item => item && item.scope === scope(account, workspace) && typeof item.prompt === 'string').map(item => item.prompt as string).slice(-MAX_PROMPTS) : []
  } catch { return [] }
}

export async function appendPromptHistory(account: string | null | undefined, workspace: string, prompt: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const value = safePrompt(prompt); if (!value) return
  let rows: Array<{ scope: string; prompt: string; at: string }> = []
  try { const parsed = JSON.parse(await readFile(file(env), 'utf8')); if (Array.isArray(parsed)) rows = parsed.filter(item => item && typeof item.scope === 'string' && typeof item.prompt === 'string') as typeof rows } catch { /* first use */ }
  const key = scope(account, workspace)
  rows = [...rows, { scope: key, prompt: value, at: new Date().toISOString() }].slice(-MAX_PROMPTS * 8)
  const target = file(env), temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try { await writeFile(temporary, JSON.stringify(rows) + '\n', { mode: 0o600, flag: 'wx' }); await chmod(temporary, 0o600); await rename(temporary, target); await chmod(target, 0o600) }
  catch (error) { await import('node:fs/promises').then(fs => fs.unlink(temporary)).catch(() => undefined); throw error }
}
