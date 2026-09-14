import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
const server = new McpServer({ name: 'fake', version: '1.0.0' })
server.registerTool('echo', { description: 'Read-only echo', inputSchema: { value: z.string() }, annotations: { readOnlyHint: true } }, async ({ value }) => ({ content: [{ type: 'text', text: value }] }))
server.registerTool('write_note', { description: 'Side effecting test tool', inputSchema: { value: z.string() } }, async ({ value }) => ({ content: [{ type: 'text', text: `wrote ${value}` }] }))
await server.connect(new StdioServerTransport())
