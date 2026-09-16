import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type PermissionProfile = 'read-only' | 'approval-required' | 'workspace-write'
const filename = (env: NodeJS.ProcessEnv = process.env) => env.SWICO_CLI_PREFERENCES_FILE ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'swico', 'preferences.json')

export async function loadPermissionProfile(env: NodeJS.ProcessEnv = process.env): Promise<PermissionProfile> {
  try {
    const value = JSON.parse(await readFile(filename(env), 'utf8')) as { permission_profile?: unknown }
    if (value.permission_profile === 'read-only' || value.permission_profile === 'workspace-write') return value.permission_profile
    return 'approval-required'
  } catch { return 'approval-required' }
}

export async function savePermissionProfile(profile: PermissionProfile, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = filename(env), directory = dirname(target), temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, JSON.stringify({ permission_profile: profile }) + '\n', { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, target)
    await chmod(target, 0o600)
  } catch (error) {
    await import('node:fs/promises').then(fs => fs.unlink(temporary)).catch(() => undefined)
    throw error
  }
}
