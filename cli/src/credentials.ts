import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CliTokens } from './contracts.js'

const memory = new Map<string, CliTokens>()
const exec = promisify(execFile)
function key(env = process.env) { return env.SWICO_API_BASE_URL ?? env.SWICO_API_URL ?? 'https://swico.in' }
function filePath(env = process.env) { return env.SWICO_CLI_CREDENTIAL_FILE ?? join(homedir(), '.config', 'swico', 'credentials.json') }

export async function saveTokens(tokens: CliTokens, env = process.env): Promise<void> {
  memory.set(key(env), tokens)
  if (process.platform === 'darwin') {
    try {
      await exec('security', ['add-generic-password', '-U', '-s', `swico-cli:${key(env)}`, '-a', key(env), '-w', JSON.stringify(tokens)])
      return
    } catch { /* use explicit fallback or safe in-memory storage */ }
  }
  const target = env.SWICO_CLI_CREDENTIAL_FILE
  if (!target) return // OS keychain adapters can be installed by platform packages; memory is the safe default.
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, JSON.stringify({ endpoint: key(env), tokens }), { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(target, 0o600)
}
export async function loadTokens(env = process.env): Promise<CliTokens | null> {
  const found = memory.get(key(env)); if (found) return found
  if (process.platform === 'darwin') {
    try {
      const result = await exec('security', ['find-generic-password', '-s', `swico-cli:${key(env)}`, '-a', key(env), '-w'])
      const value = JSON.parse(result.stdout) as CliTokens
      if (value.access_token && value.refresh_token) { memory.set(key(env), value); return value }
    } catch { /* not saved */ }
  }
  if (!env.SWICO_CLI_CREDENTIAL_FILE) return null
  try {
    const value = JSON.parse(await readFile(filePath(env), 'utf8')) as { endpoint?: string; tokens?: CliTokens }
    if (value.endpoint !== key(env) || !value.tokens?.access_token || !value.tokens.refresh_token) return null
    return value.tokens
  } catch { return null }
}
export async function clearTokens(env = process.env): Promise<void> {
  memory.delete(key(env))
  if (process.platform === 'darwin') await exec('security', ['delete-generic-password', '-s', `swico-cli:${key(env)}`, '-a', key(env)]).catch(() => undefined)
  if (env.SWICO_CLI_CREDENTIAL_FILE) { try { await (await import('node:fs/promises')).unlink(filePath(env)) } catch { /* absent */ } }
}
