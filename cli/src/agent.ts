import { createHash, randomUUID } from 'node:crypto'
import type { AgentAction, AgentResult } from './contracts.js'
import { json } from './api.js'
import { Workspace } from './workspace.js'
import { ActionJournal } from './journal.js'

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
  constructor(private readonly workspace: Workspace, private readonly accessToken: string, private readonly env = process.env) {
    this.journal = new ActionJournal(env.SWICO_CLI_JOURNAL_FILE ?? `${workspace.root}/.swico/action-journal.jsonl`)
  }
  async execute(runId: string, action: AgentAction, approve: (description: string) => Promise<boolean>): Promise<AgentResult> {
    const payloadHash = action.payload_hash ?? actionHash(action)
    await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'prepared' })
    const accepted = await json<{ action_id: string; status?: string }>(`/agent/runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ protocol_version: 1, action_id: action.action_id || randomUUID(), action_type: action.action_type, payload: action.payload, payload_hash: payloadHash }) }, this.accessToken, this.env)
    if (accepted.action_id !== action.action_id) throw new Error('Server returned a different action identity.')
    if (accepted.status && accepted.status !== 'accepted') {
      await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: accepted.status === 'succeeded' ? 'succeeded' : accepted.status === 'failed' ? 'failed' : 'unknown' })
      return { status: accepted.status === 'succeeded' ? 'succeeded' : accepted.status === 'failed' ? 'failed' : 'unknown', result: `This action was already recorded as ${accepted.status}; it was not run again.` }
    }
    let result: unknown
    await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'executing' })
    try {
      if (action.action_type === 'list_files') result = await this.workspace.listFiles(Number(action.payload.limit ?? 200))
      else if (action.action_type === 'search_text') result = await this.workspace.searchText(String(action.payload.term ?? ''))
      else if (action.action_type === 'read_file') result = await this.workspace.readFile(String(action.payload.path ?? ''))
      else if (action.action_type === 'apply_patch') result = await this.workspace.applyPatch(String(action.payload.path ?? ''), String(action.payload.expected_sha256 ?? ''), String(action.payload.content ?? ''), description => approve(description))
      else {
        result = await this.workspace.runCommand((action.payload.argv as string[]) ?? [], Number(action.payload.timeout_ms ?? 30_000), () => approve(`Run ${(action.payload.argv as string[]).join(' ')} in ${this.workspace.root}?`))
        if (result && typeof result === 'object' && 'timed_out' in result && result.timed_out === true) throw new Error('The approved command exceeded its time limit.')
      }
      const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
      try {
        await json(`/agent/runs/${runId}/actions/${encodeURIComponent(action.action_id)}/result`, { method: 'POST', body: JSON.stringify({ action_id: action.action_id, result_hash: resultHash, status: 'succeeded' }) }, this.accessToken, this.env)
      } catch {
        await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'unknown' })
        return { status: 'unknown', result: 'The local action finished, but Swico did not confirm its result. Inspect the journal before deciding whether to reconnect.' }
      }
      await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'succeeded' })
      return { status: 'succeeded', result }
    } catch (error) {
      const resultHash = createHash('sha256').update(String(error)).digest('hex')
      try {
        await json(`/agent/runs/${runId}/actions/${encodeURIComponent(action.action_id)}/result`, { method: 'POST', body: JSON.stringify({ action_id: action.action_id, result_hash: resultHash, status: 'failed' }) }, this.accessToken, this.env)
      } catch {
        await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'unknown' })
        return { status: 'unknown', result: 'The local action outcome could not be recorded. Inspect the journal before retrying.' }
      }
      await this.journal.record({ action_id: action.action_id, action_type: action.action_type, payload_hash: payloadHash, status: 'failed' })
      return { status: 'failed', result: error instanceof Error ? error.message : 'Local action failed.' }
    }
  }
}
