import type { CliTokens } from './contracts.js'
import { json } from './api.js'
export type CloudJob = { id: string; status: 'queued' | 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'expired'; message?: string }
export async function cloudExec(tokens: CliTokens, task: string, env = process.env): Promise<CloudJob> { return json<CloudJob>('/cloud/jobs', { method: 'POST', body: JSON.stringify({ task }) }, tokens.access_token, env) }
export async function cloudStatus(tokens: CliTokens, id: string, env = process.env): Promise<CloudJob> { return json<CloudJob>(`/cloud/jobs/${encodeURIComponent(id)}`, {}, tokens.access_token, env) }
export async function cloudCancel(tokens: CliTokens, id: string, env = process.env): Promise<CloudJob> { return json<CloudJob>(`/cloud/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, tokens.access_token, env) }
