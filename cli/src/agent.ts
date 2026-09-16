import { createHash, randomUUID } from 'node:crypto'
import type { AgentAction, AgentResult } from './contracts.js'
import { json, runSubagents, streamChat } from './api.js'
import { Workspace } from './workspace.js'
import { ActionJournal } from './journal.js'
import type { PermissionProfile } from './permissions.js'
import type { McpManager } from './mcp.js'
import { HookBus } from './hooks.js'
import { boundedSubagentTasks } from './subagents.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export function actionHash(action: AgentAction): string { return createHash('sha256').update(canonical(action.payload)).digest('hex') }
export class LocalAgent {
  private readonly journal: ActionJournal
  constructor(private readonly workspace: Workspace, private readonly accessToken: string | (() => Promise<string>), private readonly env = process.env, private readonly profile: PermissionProfile = 'approval-required', private readonly signal?: AbortSignal, private readonly mcp?: McpManager, private readonly hooks = new HookBus()) {
    this.journal = new ActionJournal(env.SWICO_CLI_JOURNAL_FILE ?? `${workspace.root}/.swico/action-journal.jsonl`)
  }
  private async currentAccessToken(): Promise<string> {
    return typeof this.accessToken === 'function' ? this.accessToken() : this.accessToken
  }
  async execute(runId: string, action: AgentAction, approve: (description: string) => Promise<boolean>): Promise<AgentResult> {
    await this.hooks.emit({ event: 'pre_tool', run_id: runId, action_type: action.action_type })
    const payloadHash = action.payload_hash ?? actionHash(action)
    const previous = await this.journal.latest(action.action_id, payloadHash)
    if (previous === 'succeeded' || previous === 'failed' || previous === 'unknown') return { status: previous, result: `This action was already recorded as ${previous}; it was not run again.` }
    if (this.profile === 'read-only' && ['apply_patch', 'create_file', 'delete_file', 'move_file', 'run_command'].includes(action.action_type)) return { status: 'failed', result: 'The read-only permission profile blocks mutations and commands.' }
    if (['apply_patch', 'create_file', 'delete_file', 'move_file', 'run_command'].includes(action.action_type) && !this.workspace.agentSideEffectsAllowed()) return { status: 'failed', result: 'Local agent side effects require a positively verified OS sandbox; no action was admitted or executed.' }
    await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'prepared' })
    const accepted = await json<{ action_id: string; status?: string }>(`/agent/runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ protocol_version: action.protocol_version, action_id: action.action_id || randomUUID(), action_type: action.action_type, payload: action.payload, payload_hash: payloadHash, ...(action.reservation_id ? { reservation_id: action.reservation_id } : {}) }) }, await this.currentAccessToken(), this.env)
    if (accepted.action_id !== action.action_id) throw new Error('Server returned a different action identity.')
    if (accepted.status && accepted.status !== 'accepted') {
      await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: accepted.status === 'succeeded' ? 'succeeded' : accepted.status === 'failed' ? 'failed' : 'unknown' })
      return { status: accepted.status === 'succeeded' ? 'succeeded' : accepted.status === 'failed' ? 'failed' : 'unknown', result: `This action was already recorded as ${accepted.status}; it was not run again.` }
    }
    let result: unknown
    await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'executing' })
    try {
      if (action.action_type === 'list_files') result = await this.workspace.listFiles(Number(action.payload.limit ?? 200))
      else if (action.action_type === 'search_text') result = await this.workspace.searchText(String(action.payload.term ?? ''), Number(action.payload.limit ?? 50), { regex: action.payload.regex === true, glob: typeof action.payload.glob === 'string' ? action.payload.glob : undefined, contextLines: Number(action.payload.context_lines ?? 0) })
      else if (action.action_type === 'read_file') result = await this.workspace.readFile(String(action.payload.path ?? ''))
      else if (action.action_type === 'read_file_range') result = await this.workspace.readFileRange(String(action.payload.path ?? ''), Number(action.payload.start ?? 1), Number(action.payload.end ?? 1))
      else if (action.action_type === 'git_status') result = await this.workspace.gitStatus()
      else if (action.action_type === 'git_diff') result = await this.workspace.gitDiff(typeof action.payload.ref === 'string' ? action.payload.ref : undefined)
      else if (action.action_type === 'apply_patch') result = await this.workspace.applyPatch(String(action.payload.path ?? ''), String(action.payload.expected_sha256 ?? ''), String(action.payload.patch ?? action.payload.content ?? ''), description => approve(description))
      else if (action.action_type === 'create_file') result = await this.workspace.createFile(String(action.payload.path ?? ''), String(action.payload.content ?? ''), description => approve(description))
      else if (action.action_type === 'delete_file') result = await this.workspace.deleteFile(String(action.payload.path ?? ''), description => approve(description))
      else if (action.action_type === 'move_file') result = await this.workspace.moveFile(String(action.payload.from ?? ''), String(action.payload.to ?? ''), description => approve(description))
      else if (action.action_type === 'mcp_tool') {
        if (!this.mcp) throw new Error('MCP is not configured for this session.')
        result = await this.mcp.call(String(action.payload.server_name ?? ''), String(action.payload.tool_name ?? ''), (action.payload.arguments ?? {}) as Record<string, unknown>, approve, this.signal)
      } else if (action.action_type === 'spawn_subagent') {
        const tasks = boundedSubagentTasks(Array.isArray(action.payload.tasks) ? action.payload.tasks.map(item => ({ id: String((item as Record<string, unknown>).id ?? ''), task: String((item as Record<string, unknown>).task ?? '') })) : [])
        result = await runSubagents({ access_token: await this.currentAccessToken() }, runId, action.action_id, tasks, typeof action.payload.context === 'string' ? action.payload.context : '', this.env, this.signal)
      } else if (action.action_type === 'web_search') {
        const answer = await streamChat({ access_token: await this.currentAccessToken() }, String(action.payload.query ?? ''), undefined, undefined, this.env, { signal: this.signal, searchMode: 'on' })
        result = answer.text
      } else {
        const network = action.payload.network === 'allowed' ? 'allowed' : 'disabled'
        result = await this.workspace.runCommand((action.payload.argv as string[]) ?? [], Number(action.payload.timeout_ms ?? 30_000), description => approve(description ?? `Run ${(action.payload.argv as string[]).join(' ')} in ${this.workspace.root}?`), this.signal, network)
        if (result && typeof result === 'object' && 'timed_out' in result && result.timed_out === true) throw new Error('The approved command exceeded its time limit.')
        if (result && typeof result === 'object' && 'cancelled' in result && result.cancelled === true) throw new Error('The approved command was cancelled.')
      }
      const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
      try {
        await json(`/agent/runs/${runId}/actions/${encodeURIComponent(action.action_id)}/result`, { method: 'POST', body: JSON.stringify({ action_id: action.action_id, result_hash: resultHash, status: 'succeeded' }) }, await this.currentAccessToken(), this.env)
      } catch {
        await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'unknown' })
        return { status: 'unknown', result: 'The local action finished, but Swico did not confirm its result. Inspect the journal before deciding whether to reconnect.' }
      }
      await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'succeeded' })
      await this.hooks.emit({ event: 'post_tool', run_id: runId, action_type: action.action_type, summary: 'succeeded' })
      return { status: 'succeeded', result }
    } catch (error) {
      const resultHash = createHash('sha256').update(String(error)).digest('hex')
      try {
        await json(`/agent/runs/${runId}/actions/${encodeURIComponent(action.action_id)}/result`, { method: 'POST', body: JSON.stringify({ action_id: action.action_id, result_hash: resultHash, status: 'failed' }) }, await this.currentAccessToken(), this.env)
      } catch {
        await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'unknown' })
        return { status: 'unknown', result: 'The local action outcome could not be recorded. Inspect the journal before retrying.' }
      }
      await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'failed' })
      await this.hooks.emit({ event: 'post_tool', run_id: runId, action_type: action.action_type, summary: 'failed' })
      return { status: 'failed', result: error instanceof Error ? error.message : 'Local action failed.' }
    }
  }
}
