import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerDefinition, SwicoConfig } from './configuration.js'
import { validateMcpDefinition } from './configuration.js'
import { ActionJournal } from './journal.js'
import { createSandboxAdapter, type SandboxAdapter } from './sandbox.js'

export type McpCapability = 'read' | 'write' | 'network' | 'unknown'
export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>; capability: McpCapability }
export type McpDiagnostic = { name: string; transport: string; status: 'unconfigured' | 'ready' | 'failed'; toolCount: number; error?: string }
const MAX_TOOLS = 32, MAX_RESULT = 64 * 1024, MAX_SCHEMA = 8 * 1024, MAX_ARGS = 32 * 1024
const packageJson = createRequire(import.meta.url)('../package.json') as { version?: string }

function bounded(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? '').slice(0, max)
}
function capability(tool: { annotations?: Record<string, unknown> }): McpCapability {
  const annotations = tool.annotations ?? {}
  if (annotations.readOnlyHint === true) return 'read'
  if (annotations.openWorldHint === true) return 'network'
  return annotations.destructiveHint === true ? 'write' : 'unknown'
}
function safeEnv(names: string[] | undefined, source = process.env): Record<string, string> {
  const result: Record<string, string> = { PATH: source.PATH ?? '', ...(process.platform === 'win32' && source.SystemRoot ? { SystemRoot: source.SystemRoot } : {}) }
  for (const name of names ?? []) if (Object.prototype.hasOwnProperty.call(source, name) && source[name] !== undefined) result[name] = source[name] as string
  return result
}
function redacted(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '')
  return JSON.stringify(value, (key, item) => /token|secret|password|authorization|api.?key/i.test(key) ? '[redacted]' : item).slice(0, 1000)
}

export class McpManager {
  private readonly clients = new Map<string, { client: Client; transport: StdioClientTransport | StreamableHTTPClientTransport; tools: McpTool[] }>()
  private readonly journal: ActionJournal
  constructor(private readonly config: SwicoConfig, journalFile?: string, private readonly sandbox: SandboxAdapter = createSandboxAdapter(process.cwd()), private readonly sandboxVerified = false, private readonly allowReadOnlyTools = false) { this.journal = new ActionJournal(journalFile ?? `${process.cwd()}/.swico/mcp-action-journal.jsonl`) }
  definitions(): McpServerDefinition[] { return this.config.mcp.slice(0, 32) }
  private definition(name: string): McpServerDefinition { const item = this.config.mcp.find(value => value.name === name); if (!item) throw new Error(`MCP server '${name}' is not configured.`); validateMcpDefinition(item, item.source === 'user'); if (!item.trusted) throw new Error(`MCP server '${name}' is project configuration and must be explicitly added by the user before use.`); return item }
  private async connect(definition: McpServerDefinition): Promise<{ client: Client; tools: McpTool[] }> {
    const cached = this.clients.get(definition.name); if (cached) return cached
    const client = new Client({ name: 'swico', version: packageJson.version ?? 'unknown' }, { capabilities: {} })
    let transport: StdioClientTransport | StreamableHTTPClientTransport
    if (definition.transport === 'stdio') {
      if (!this.sandbox.status().available || !this.sandboxVerified) throw new Error(`MCP server requires verified local confinement before stdio discovery or calls: ${this.sandbox.status().reason}`)
      const wrapped = this.sandbox.wrap([definition.command as string, ...(definition.args ?? [])], 'read-only', 'disabled')
      transport = new StdioClientTransport({ command: wrapped.command, args: wrapped.args, cwd: definition.cwd, env: safeEnv(definition.env), stderr: 'pipe', maxBufferSize: MAX_RESULT })
    } else {
      const url = new URL(definition.url as string)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(definition.headers ?? {})) { const name = value.slice(2, -1); if (process.env[name]) headers[key] = process.env[name] as string }
      const fetchNoRedirect: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error', headers: { ...(init?.headers ?? {}), ...headers } })
      transport = new StreamableHTTPClientTransport(url, { fetch: fetchNoRedirect, requestInit: { redirect: 'error' }, reconnectionOptions: { maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1, maxRetries: 0 } })
    }
    await client.connect(transport, { timeout: 15_000 })
    const response = await client.listTools({}, { timeout: 15_000 })
    const tools = (response.tools ?? []).slice(0, MAX_TOOLS).map((tool) => {
      const schema = tool.inputSchema as Record<string, unknown> | undefined
      if (Buffer.byteLength(JSON.stringify(schema ?? {})) > MAX_SCHEMA) throw new Error(`MCP tool schema is too large: ${tool.name}`)
      return { name: tool.name, description: bounded(tool.description ?? '', 4_000), inputSchema: schema, annotations: tool.annotations as Record<string, unknown> | undefined, capability: capability(tool) }
    })
    const result = { client, transport, tools }; this.clients.set(definition.name, result); return result
  }
  async discover(name: string): Promise<McpTool[]> { return (await this.connect(this.definition(name))).tools }
  async diagnostics(): Promise<McpDiagnostic[]> {
    const result: McpDiagnostic[] = []
    for (const definition of this.definitions()) { try { result.push({ name: definition.name, transport: definition.transport, status: definition.trusted ? 'ready' : 'unconfigured', toolCount: definition.trusted ? (await this.discover(definition.name)).length : 0 }) } catch (error) { result.push({ name: definition.name, transport: definition.transport, status: 'failed', toolCount: 0, error: error instanceof Error ? error.message.slice(0, 160) : 'MCP connection failed.' }) } }
    return result
  }
  async call(name: string, toolName: string, args: Record<string, unknown>, approve: (description: string) => Promise<boolean>, signal?: AbortSignal): Promise<unknown> {
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS) throw new Error('MCP arguments exceed the supported bound.')
    const { client, tools } = await this.connect(this.definition(name)), tool = tools.find(item => item.name === toolName)
    if (!tool) throw new Error(`MCP tool '${toolName}' is not available on '${name}'.`)
    if ((!this.allowReadOnlyTools || tool.capability !== 'read') && !await approve(`MCP ${name}:${toolName} (${tool.capability}) with arguments ${redacted(args)}?`)) throw new Error('MCP tool call was not approved.')
    const actionId = `mcp:${name}:${toolName}`, payloadHash = createHash('sha256').update(JSON.stringify(args)).digest('hex')
    const previous = await this.journal.latest(actionId, payloadHash); if (previous === 'succeeded') return 'This MCP call was already completed; its result was not run again.'
    await this.journal.record({ action_id: actionId, action_type: 'mcp_tool', payload_hash: payloadHash, status: 'executing' })
    try {
      const response = await client.callTool({ name: toolName, arguments: args }, undefined, { signal, timeout: 15_000 })
      const value = bounded((response as { content?: unknown }).content ?? response, MAX_RESULT)
      await this.journal.record({ action_id: actionId, action_type: 'mcp_tool', payload_hash: payloadHash, status: 'succeeded' })
      return value
    } catch (error) { await this.journal.record({ action_id: actionId, action_type: 'mcp_tool', payload_hash: payloadHash, status: 'unknown' }); throw new Error(`MCP call failed: ${error instanceof Error ? error.message.slice(0, 240) : 'unknown error'}`) }
  }
  async close(): Promise<void> { for (const item of this.clients.values()) await item.client.close().catch(() => undefined); this.clients.clear() }
}
