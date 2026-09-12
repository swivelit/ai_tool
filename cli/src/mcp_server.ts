import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { discoverRepository } from './repository.js'
import { Workspace } from './workspace.js'

/** Safe, read-only MCP surface. Mutating local tools remain unavailable until Stage 3 sandboxing. */
export async function runMcpServer(): Promise<void> {
  const metadata = await discoverRepository(process.env.SWICO_CLI_WORKSPACE ?? process.cwd()), workspace = new Workspace(metadata.root)
  const server = new McpServer({ name: 'swico', version: '0.1.0' })
  server.registerTool('repository_status', { description: 'Return bounded repository status for the selected workspace.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: JSON.stringify(await workspace.gitStatus().catch(() => metadata)) }] }))
  server.registerTool('list_files', { description: 'List safe files in the selected workspace.', inputSchema: { limit: z.number().int().min(1).max(200).optional() }, annotations: { readOnlyHint: true } }, async ({ limit }) => ({ content: [{ type: 'text', text: JSON.stringify(await workspace.listFiles(limit ?? 100)) }] }))
  server.registerTool('review_diff', { description: 'Read the current uncommitted diff; no files are changed.', inputSchema: { ref: z.string().max(256).optional() }, annotations: { readOnlyHint: true } }, async ({ ref }) => ({ content: [{ type: 'text', text: (await workspace.gitDiff(ref)).slice(0, 64 * 1024) }] }))
  await server.connect(new StdioServerTransport())
}
