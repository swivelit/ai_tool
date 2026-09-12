import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverRepository } from './repository.js'
import type { PermissionProfile } from './permissions.js'

export type SearchMode = 'auto' | 'on' | 'off'
export type ConfigSource = 'user' | 'project'
export type McpServerDefinition = {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  env?: string[]
  url?: string
  headers?: Record<string, string>
  source: ConfigSource
  trusted: boolean
}
export type SwicoConfig = {
  source: ConfigSource
  path: string
  searchMode: SearchMode
  defaultMode: 'chat' | 'agent' | 'plan' | 'auto'
  autoSkills: boolean
  permissionProfile?: PermissionProfile
  hooksEnabled: boolean
  mcp: McpServerDefinition[]
}

const MAX_CONFIG_BYTES = 64 * 1024
const MAX_MCP = 32
const MAX_ARGS = 32
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SWICO_CLI_CONFIG_FILE) return resolve(env.SWICO_CLI_CONFIG_FILE)
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'swico', 'config.toml')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'swico', 'config.toml')
}

export function projectConfigPath(root: string): string { return join(root, '.swico', 'config.toml') }
export function configPaths(_cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): { user: string; project: string | null } {
  const user = userConfigPath(env)
  return { user, project: join(resolve(_cwd), '.swico', 'config.toml') }
}

function scalar(value: string): string | boolean | string[] {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const body = trimmed.slice(1, -1).trim()
    if (!body) return []
    const values: string[] = []
    for (const item of body.split(',')) {
      const entry = item.trim()
      if (!/^"(?:[^"\\]|\\.)*"$/.test(entry)) throw new Error('Arrays in Swico config must contain quoted strings.')
      values.push(JSON.parse(entry) as string)
    }
    return values
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) return JSON.parse(trimmed) as string
  throw new Error('Swico config values must be quoted strings, booleans, or string arrays.')
}

function parseToml(text: string, source: ConfigSource, path: string): SwicoConfig {
  const base: SwicoConfig = { source, path, searchMode: 'auto', defaultMode: 'auto', autoSkills: true, hooksEnabled: false, mcp: [] }
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = /^\[mcp\."([^"\r\n]{1,80})"\]$/.exec(line)
    if (sectionMatch) { section = `mcp:${sectionMatch[1]}`; if (!base.mcp.some(item => item.name === sectionMatch[1])) base.mcp.push({ name: sectionMatch[1], transport: 'stdio', source, trusted: source === 'user' }); continue }
    if (line === '[hooks]') { section = 'hooks'; continue }
    if (line === '[skills]') { section = 'skills'; continue }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line)
    if (!match) throw new Error(`Invalid Swico config line in ${path}.`)
    const [, key, rawValue] = match, value = scalar(rawValue)
    if (section.startsWith('mcp:')) {
      const item = base.mcp.find(entry => entry.name === section.slice(4))
      if (!item) throw new Error('Invalid MCP config section.')
      if (key === 'transport' && (value === 'stdio' || value === 'http')) item.transport = value
      else if (key === 'command' && typeof value === 'string') item.command = value
      else if (key === 'args' && Array.isArray(value)) item.args = value
      else if (key === 'cwd' && typeof value === 'string') item.cwd = value
      else if (key === 'env' && Array.isArray(value) && value.every(itemName => ENV_NAME.test(itemName))) item.env = value
      else if (key === 'url' && typeof value === 'string') item.url = value
      else if (key.startsWith('header_') && typeof value === 'string') item.headers = { ...item.headers, [key.slice(7)]: value }
      else throw new Error(`Unsupported or invalid MCP setting '${key}' in ${path}.`)
    } else if (section === 'hooks') {
      if (key !== 'enabled' || typeof value !== 'boolean') throw new Error(`Only hooks.enabled is supported in ${path}.`)
      base.hooksEnabled = value
    } else if (section === 'skills') {
      if (key !== 'auto' || typeof value !== 'boolean') throw new Error(`Only skills.auto is supported in ${path}.`)
      base.autoSkills = value
    } else if (key === 'search_mode' && (value === 'auto' || value === 'on' || value === 'off')) base.searchMode = value
    else if (key === 'default_mode' && (value === 'auto' || value === 'chat' || value === 'agent' || value === 'plan')) base.defaultMode = value
    else if (key === 'permission_profile' && (value === 'read-only' || value === 'approval-required')) base.permissionProfile = value
    else throw new Error(`Unsupported or invalid setting '${key}' in ${path}.`)
  }
  if (base.mcp.length > MAX_MCP) throw new Error(`MCP server count exceeds ${MAX_MCP}.`)
  for (const server of base.mcp) validateMcpDefinition(server, source === 'user')
  if (source === 'project') {
    base.hooksEnabled = false
    base.permissionProfile = base.permissionProfile === 'read-only' ? 'read-only' : undefined
    for (const server of base.mcp) server.trusted = false
  }
  return base
}

export function validateMcpDefinition(server: McpServerDefinition, userConfig = false): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(server.name)) throw new Error('MCP server name is invalid.')
  if (server.args && (server.args.length > MAX_ARGS || server.args.some(value => value.length > 512))) throw new Error('MCP argument bounds exceeded.')
  if (server.env && server.env.some(value => !ENV_NAME.test(value))) throw new Error('MCP env entries must be variable names.')
  if (server.transport === 'stdio') {
    if (!server.command || server.command.length > 512 || (server.args ?? []).some(value => typeof value !== 'string' || value.length > 512)) throw new Error('stdio MCP server requires a bounded command and arguments.')
    if (!userConfig && server.trusted) throw new Error('Project MCP servers cannot be trusted by configuration.')
  } else {
    if (!server.url || server.url.length > 2048) throw new Error('HTTP MCP server requires a bounded URL.')
    const parsed = new URL(server.url)
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
    if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) || parsed.username || parsed.password || parsed.hash) throw new Error('HTTP MCP servers require HTTPS and must not contain URL credentials.')
    if (server.headers && (Object.keys(server.headers).length > 16 || Object.entries(server.headers).some(([key, value]) => !/^[A-Za-z0-9-]{1,64}$/.test(key) || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)))) throw new Error('MCP headers must reference named environment variables.')
  }
}

async function readConfig(path: string, source: ConfigSource): Promise<SwicoConfig | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Swico ${source} configuration must be a regular file: ${path}`)
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error(`Swico config exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`)
    return parseToml(text, source, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function loadConfig(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<{ effective: SwicoConfig; user: SwicoConfig | null; project: SwicoConfig | null }> {
  const user = await readConfig(userConfigPath(env), 'user')
  const metadata = await discoverRepository(cwd)
  const localPath = projectConfigPath(metadata.root)
  const project = await readConfig(localPath, 'project')
  const effective: SwicoConfig = user ? { ...user, mcp: [...user.mcp] } : { source: 'user', path: userConfigPath(env), searchMode: 'auto', defaultMode: 'auto', autoSkills: true, hooksEnabled: false, mcp: [] }
  if (project) {
    // Project configuration can narrow behavior, but never grants trust or
    // raises permissions. Project MCP entries are inspection-only until the
    // user explicitly adds an equivalent server to user config.
    if (project.searchMode !== 'auto') effective.searchMode = project.searchMode
    if (project.defaultMode === 'chat' || project.defaultMode === 'plan') effective.defaultMode = project.defaultMode
    if (project.autoSkills === false) effective.autoSkills = false
    if (project.permissionProfile === 'read-only') effective.permissionProfile = 'read-only'
    effective.mcp.push(...project.mcp)
  }
  return { effective, user, project }
}

function quote(value: string): string { return JSON.stringify(value) }
function renderConfig(config: SwicoConfig): string {
  const lines = [`search_mode = ${quote(config.searchMode)}`, `default_mode = ${quote(config.defaultMode)}`]
  lines.push('', '[skills]', `auto = ${config.autoSkills ? 'true' : 'false'}`, '', '[hooks]', 'enabled = false')
  for (const server of config.mcp.filter(item => item.source === 'user')) {
    lines.push('', `[mcp.${quote(server.name)}]`, `transport = ${quote(server.transport)}`)
    if (server.command) lines.push(`command = ${quote(server.command)}`)
    if (server.args?.length) lines.push(`args = [${server.args.map(quote).join(', ')}]`)
    if (server.cwd) lines.push(`cwd = ${quote(server.cwd)}`)
    if (server.env?.length) lines.push(`env = [${server.env.map(quote).join(', ')}]`)
    if (server.url) lines.push(`url = ${quote(server.url)}`)
    for (const [header, value] of Object.entries(server.headers ?? {})) lines.push(`header_${header} = ${quote(value)}`)
  }
  return `${lines.join('\n')}\n`
}

export async function saveUserConfig(config: SwicoConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = userConfigPath(env), temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try { await writeFile(temporary, renderConfig(config), { mode: 0o600, flag: 'wx' }); await chmod(temporary, 0o600); await rename(temporary, target); await chmod(target, 0o600) }
  catch (error) { await import('node:fs/promises').then(fs => fs.unlink(temporary)).catch(() => undefined); throw error }
}

export function configSummary(value: SwicoConfig): Record<string, unknown> {
  return { source: value.source, path: value.path, search_mode: value.searchMode, default_mode: value.defaultMode, auto_skills: value.autoSkills, permission_profile: value.permissionProfile ?? 'approval-required', hooks_enabled: value.hooksEnabled, mcp: value.mcp.map(item => ({ name: item.name, transport: item.transport, source: item.source, trusted: item.trusted })) }
}
