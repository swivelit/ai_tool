import { randomUUID } from 'node:crypto'
import type { CliTokens } from './contracts.js'
import { json } from './api.js'
import type { CloudSnapshot } from './cloud_snapshot.js'
export type CloudJob = { id: string; request_id: string; source: string; tier: string; task: string; status: 'queued' | 'dispatching' | 'starting' | 'running' | 'waiting_for_approval' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'expired'; created_at: string; started_at?: string | null; finished_at?: string | null; expires_at: string; attempt: number; result?: Record<string, unknown>; failure_code?: string | null; idempotent?: boolean }
export type CloudEvent = { sequence: number; event_type: string; payload: Record<string, unknown>; created_at: string }
export async function cloudExec(tokens: CliTokens, task: string, env = process.env, source: 'workspace_snapshot' | 'task_only' = 'workspace_snapshot', snapshot?: CloudSnapshot): Promise<CloudJob> {
  const job = await json<CloudJob>('/cloud/jobs', { method: 'POST', body: JSON.stringify({ request_id: randomUUID(), source, task }) }, tokens.access_token, env)
  if (source === 'workspace_snapshot' && snapshot) await json(`/cloud/jobs/${encodeURIComponent(job.id)}/snapshot`, { method: 'POST', body: JSON.stringify(snapshot) }, tokens.access_token, env)
  return job
}
export async function cloudStatus(tokens: CliTokens, id: string, env = process.env): Promise<CloudJob> { return json<CloudJob>(`/cloud/jobs/${encodeURIComponent(id)}`, {}, tokens.access_token, env) }
export async function cloudCancel(tokens: CliTokens, id: string, env = process.env): Promise<CloudJob> { return json<CloudJob>(`/cloud/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, tokens.access_token, env) }
export async function cloudList(tokens: CliTokens, env = process.env): Promise<{ items: CloudJob[] }> { return json<{ items: CloudJob[] }>('/cloud/jobs', {}, tokens.access_token, env) }
export async function cloudEvents(tokens: CliTokens, id: string, env = process.env): Promise<{ job_id: string; items: CloudEvent[] }> { return json<{ job_id: string; items: CloudEvent[] }>(`/cloud/jobs/${encodeURIComponent(id)}/events`, {}, tokens.access_token, env) }
