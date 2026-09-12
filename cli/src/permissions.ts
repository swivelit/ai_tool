import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type PermissionProfile = 'read-only' | 'approval-required'
const filename = () => process.env.SWICO_CLI_PREFERENCES_FILE ?? join(homedir(), '.config', 'swico', 'preferences.json')

export async function loadPermissionProfile(): Promise<PermissionProfile> {
  try {
    const value = JSON.parse(await readFile(filename(), 'utf8')) as { permission_profile?: unknown }
    return value.permission_profile === 'read-only' ? 'read-only' : 'approval-required'
  } catch { return 'approval-required' }
}

export async function savePermissionProfile(profile: PermissionProfile): Promise<void> {
  const target = filename(), directory = dirname(target), temporary = `${target}.${randomUUID()}.tmp`
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
