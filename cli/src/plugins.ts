import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import type { RepositoryMetadata } from './repository.js'

export type SwicoPlugin = {
  name: string; version: string; description?: string; skills?: string[]; mcp?: string[]; hooks?: string[]
  entrypoint?: string; permissions: string[]; path: string; manifest_path: string
  manifest_hash: string; entrypoint_hash?: string; trusted: boolean
}
export type PluginTrust = {
  path: string; manifest_hash: string; entrypoint_hash?: string; name: string; version: string; permissions: string[]
}
const forbidden = new Set(['main', 'entry', 'scripts', 'dependencies', 'install'])
const trustFile = (env: NodeJS.ProcessEnv = process.env) => env.SWICO_CLI_PLUGIN_TRUST_FILE ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'swico', 'plugin-trust.json')
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

async function executableBundleHash(root: string): Promise<string> {
  const files: Array<{ path: string; content: Buffer }> = []
  let bytes = 0
  const visit = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Plugin bundles cannot contain symbolic links.')
      const path = join(directory, item.name)
      if (item.isDirectory()) { await visit(path); continue }
      if (!item.isFile()) throw new Error('Plugin bundles may contain only regular files.')
      const content = await readFile(path); bytes += content.byteLength
      if (files.length >= 512 || bytes > 16 * 1024 * 1024) throw new Error('Plugin executable bundle is outside the supported bound.')
      files.push({ path: relative(root, path).replaceAll('\\', '/'), content })
    }
  }
  await visit(root)
  const digest = createHash('sha256')
  for (const item of files.sort((a, b) => a.path.localeCompare(b.path))) digest.update(item.path).update('\0').update(item.content).update('\0')
  return digest.digest('hex')
}

function safeRelative(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return normalized.length > 0 && !normalized.startsWith('/') && !normalized.split('/').includes('..')
}

export function validatePlugin(value: unknown, path: string, details: Partial<Pick<SwicoPlugin, 'manifest_path' | 'manifest_hash' | 'entrypoint_hash' | 'trusted'>> = {}): SwicoPlugin {
  if (!value || typeof value !== 'object') throw new Error('Plugin manifest must be an object.')
  const item = value as Record<string, unknown>
  for (const key of forbidden) if (key in item) throw new Error(`Plugin manifest cannot contain executable field '${key}'.`)
  if (typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.name) || typeof item.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(item.version)) throw new Error('Plugin manifest requires a safe name and version.')
  const arrays = (key: string) => item[key] === undefined ? [] : Array.isArray(item[key]) && item[key].every(value => typeof value === 'string' && value.length < 256) ? item[key] as string[] : (() => { throw new Error(`Plugin ${key} must be a bounded string array.`) })()
  const entrypoint = item.entrypoint === undefined ? undefined : typeof item.entrypoint === 'string' && safeRelative(item.entrypoint) && item.entrypoint.length < 512 ? item.entrypoint : (() => { throw new Error('Plugin entrypoint must be a bounded relative path.') })()
  return {
    name: item.name, version: item.version, description: typeof item.description === 'string' ? item.description.slice(0, 512) : undefined,
    skills: arrays('skills'), mcp: arrays('mcp'), hooks: arrays('hooks'), entrypoint, permissions: arrays('permissions').slice(0, 16),
    path, manifest_path: details.manifest_path ?? path, manifest_hash: details.manifest_hash ?? '', entrypoint_hash: details.entrypoint_hash,
    trusted: details.trusted === true,
  }
}

async function readTrust(env: NodeJS.ProcessEnv = process.env): Promise<PluginTrust[]> {
  try { const parsed = JSON.parse(await readFile(trustFile(env), 'utf8')); return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object').slice(-128) as PluginTrust[] : [] } catch { return [] }
}
async function writeTrust(items: PluginTrust[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = trustFile(env), temporary = `${target}.${Date.now()}.tmp`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(temporary, JSON.stringify(items.slice(-128), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, target); await chmod(target, 0o600)
}
async function pluginTrusted(plugin: SwicoPlugin, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await readTrust(env)).some(item => item.path === plugin.path && item.name === plugin.name && item.version === plugin.version && item.manifest_hash === plugin.manifest_hash && item.entrypoint_hash === plugin.entrypoint_hash && JSON.stringify(item.permissions) === JSON.stringify(plugin.permissions))
}

export async function inspectPlugin(path: string, env: NodeJS.ProcessEnv = process.env): Promise<SwicoPlugin> {
  const real = await realpath(resolve(path)), manifest = real.endsWith('swico-plugin.json') ? real : join(real, 'swico-plugin.json'), root = dirname(manifest)
  const info = await lstat(manifest); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Plugin manifest must be a regular local file.')
  const text = await readFile(manifest, 'utf8'); if (Buffer.byteLength(text) > 32 * 1024) throw new Error('Plugin manifest is too large.')
  const plugin = validatePlugin(JSON.parse(text), root, { manifest_path: manifest, manifest_hash: hash(text) })
  if (plugin.entrypoint) {
    const entry = resolve(root, plugin.entrypoint), rel = relative(root, entry)
    if (!safeRelative(rel) || !rel || rel.startsWith('..')) throw new Error('Plugin entrypoint escapes the plugin root.')
    const entryInfo = await lstat(entry); if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) throw new Error('Plugin entrypoint must be a regular local file.')
    // Bind trust to the complete local bundle, including loaded scripts and
    // dependencies, rather than only to the top-level entrypoint.
    plugin.entrypoint_hash = await executableBundleHash(root)
  }
  plugin.trusted = await pluginTrusted(plugin, env)
  return plugin
}

export async function trustPlugin(path: string, env: NodeJS.ProcessEnv = process.env): Promise<SwicoPlugin> {
  const plugin = await inspectPlugin(path, env)
  if (!plugin.entrypoint) throw new Error('This plugin is declarative and needs no executable trust grant.')
  await writeTrust([...((await readTrust(env)).filter(item => item.path !== plugin.path)), { path: plugin.path, manifest_hash: plugin.manifest_hash, entrypoint_hash: plugin.entrypoint_hash, name: plugin.name, version: plugin.version, permissions: plugin.permissions }], env)
  return { ...plugin, trusted: true }
}
export async function untrustPlugin(path: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const plugin = await inspectPlugin(path, env); await writeTrust((await readTrust(env)).filter(item => item.path !== plugin.path), env) }

export async function listPlugins(metadata?: RepositoryMetadata, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<SwicoPlugin[]> {
  const paths = [join(cwd, '.swico', 'plugins'), ...(metadata ? [join(metadata.root, '.swico', 'plugins')] : [])], result: SwicoPlugin[] = []
  for (const directory of paths) {
    try { for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) try { result.push(await inspectPlugin(join(directory, entry.name), env)) } catch { /* inspect command reports malformed manifests */ } } catch { /* optional directory */ }
  }
  return result.slice(0, 32)
}
