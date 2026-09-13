import { createHash, randomUUID } from 'node:crypto'
import { apiBaseUrl, cliApi } from './config.js'
import { SSEParser, type SSEEvent } from './sse.js'
import type { CliTokens, PublicTier } from './contracts.js'
import { ensureTokens } from './session.js'

export class CliApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message) }
}

export async function probeEndpoint(env = process.env): Promise<{ status: number; state: 'enabled' | 'disabled' | 'unavailable' | 'unexpected'; detail?: string; agent_enabled?: boolean }> {
  try {
    const response = await fetch(`${apiBaseUrl(env)}/api/cli/v1/health`, { headers: { Accept: 'application/json' }, redirect: 'error' })
    const text = (await response.text()).slice(0, 500)
    if (text.trimStart().startsWith('<')) return { status: response.status, state: 'unexpected', detail: 'The endpoint returned HTML instead of the Swico API.' }
    let body: { cli_enabled?: unknown; agent_enabled?: unknown; message?: unknown; detail?: unknown } = {}
    try { body = JSON.parse(text) as typeof body } catch { return { status: response.status, state: 'unexpected', detail: 'The readiness endpoint returned invalid JSON.' } }
    if (!response.ok) return { status: response.status, state: 'unexpected', detail: typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}` }
    if (typeof body.cli_enabled !== 'boolean') return { status: response.status, state: 'unexpected', detail: 'The readiness endpoint returned no CLI rollout state.' }
    return { status: response.status, state: body.cli_enabled ? 'enabled' : 'disabled', agent_enabled: body.agent_enabled === true, detail: typeof body.message === 'string' ? body.message : undefined }
  } catch (error) {
    return { status: 0, state: 'unavailable', detail: error instanceof Error ? error.message.slice(0, 160) : 'Network request failed.' }
  }
}

export async function json<T>(path: string, init: RequestInit = {}, accessToken?: string, env = process.env): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(cliApi(path, env), { ...init, headers, redirect: 'error' })
  const body = await response.json().catch(() => ({})) as unknown
  if (!response.ok) {
    const detail = typeof body === 'object' && body && 'detail' in body ? (body as { detail: unknown }).detail : body
    const message = typeof detail === 'string' ? detail : typeof detail === 'object' && detail && 'message' in detail ? String((detail as { message: unknown }).message) : `Swico request failed (${response.status})`
    throw new CliApiError(response.status, message, body)
  }
  return body as T
}

export async function createDevice(verifier: string, scopes: string[], env = process.env, tier?: Exclude<PublicTier, 'free'>) {
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return json<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }>('/device', {
    method: 'POST', body: JSON.stringify({ client_id: 'swico-cli', code_challenge: challenge, device_description: `Swico CLI on ${process.platform}`, scopes, ...(tier ? { tier } : {}) }),
  }, undefined, env)
}

export async function exchangeDevice(deviceCode: string, verifier: string, env = process.env): Promise<CliTokens> {
  return json<CliTokens>('/token', { method: 'POST', body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, code_verifier: verifier }) }, undefined, env)
}

export async function refresh(refreshToken: string, env = process.env): Promise<CliTokens> {
  return json<CliTokens>('/token', { method: 'POST', body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }) }, undefined, env)
}

async function accessTokenFor(env: NodeJS.ProcessEnv, testTokenProvider?: () => Promise<string>): Promise<string> {
  // The installed CLI always resolves the selected session through the
  // credential store. The injected provider exists only for protocol tests;
  // there is deliberately no captured-token production fallback.
  if (testTokenProvider) return testTokenProvider()
  return (await ensureTokens(env)).access_token
}

export async function streamChat(tokens: Pick<CliTokens, 'access_token'>, message: string, threadId?: string, onEvent?: (event: SSEEvent) => void, env = process.env, options: { signal?: AbortSignal; onRequestId?: (requestId: string) => void; searchMode?: 'auto' | 'on' | 'off'; attachmentIds?: string[]; outputSchema?: Record<string, unknown>; testTokenProvider?: () => Promise<string> } = {}): Promise<{ threadId: string | null; text: string }> {
  const requestId = randomUUID()
  options.onRequestId?.(requestId)
  const response = await fetch(cliApi('/chat/stream', env), { method: 'POST', redirect: 'error', signal: options.signal, headers: { Authorization: `Bearer ${await accessTokenFor(env, options.testTokenProvider)}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ request_id: requestId, message, thread_id: threadId, input_mode: 'text', search_mode: options.searchMode ?? 'auto', attachment_ids: options.attachmentIds ?? [], ...(options.outputSchema ? { output_schema: options.outputSchema } : {}) }) })
  if (!response.ok || !response.body) throw new CliApiError(response.status, 'Swico could not start the chat request.')
  const parser = new SSEParser(); const decoder = new TextDecoder(); let text = ''; let resolvedThread: string | null = null; let done = false
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    for (const event of parser.feed(decoder.decode(chunk, { stream: true }))) {
      onEvent?.(event)
      if (event.event === 'thread' && typeof event.data === 'object' && event.data) resolvedThread = String((event.data as { thread_id?: unknown }).thread_id ?? '') || null
      if (event.event === 'delta' && typeof event.data === 'object' && event.data) text += String((event.data as { text?: unknown }).text ?? '')
      if (event.event === 'done') done = true
      if (event.event === 'error') throw new CliApiError(502, typeof event.data === 'object' && event.data && 'message' in event.data ? String((event.data as { message: unknown }).message) : 'Swico could not complete this request.')
    }
  }
  for (const event of parser.feed(decoder.decode()).concat(parser.finish())) { onEvent?.(event); if (event.event === 'done') done = true; if (event.event === 'delta' && typeof event.data === 'object' && event.data) text += String((event.data as { text?: unknown }).text ?? '') }
  if (!done) throw new CliApiError(502, 'The Swico stream ended before completion.')
  return { threadId: resolvedThread, text }
}

export async function cancelChat(tokens: CliTokens, requestId: string, env = process.env): Promise<void> {
  await json(`/chat/requests/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' }, await accessTokenFor(env), env)
}

export async function uploadImage(tokens: CliTokens, filename: string, env = process.env): Promise<{ id: string; name: string; expires_at: string }> {
  const form = new FormData(); const bytes = await (await import('node:fs/promises')).readFile(filename)
  form.append('file', new Blob([bytes]), filename)
  const response = await fetch(cliApi('/uploads', env), { method: 'POST', body: form, redirect: 'error', headers: { Authorization: `Bearer ${await accessTokenFor(env)}`, Accept: 'application/json' } })
  const body = await response.json().catch(() => ({})) as { id?: string; name?: string; expires_at?: string; detail?: unknown }
  if (!response.ok || !body.id) throw new CliApiError(response.status, typeof body.detail === 'string' ? body.detail : 'Swico could not upload that image.')
  return { id: body.id, name: body.name ?? filename, expires_at: body.expires_at ?? '' }
}
export async function deleteImage(tokens: CliTokens, id: string, env = process.env): Promise<void> { await json(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }, await accessTokenFor(env), env) }

export async function createAgentRun(tokens: CliTokens, task: string, threadId?: string, env = process.env) {
  return json<{ run_id: string; request_id: string; status: string; tier: string; max_steps: number; current_step: number; expires_at: string }>('/agent/runs', { method: 'POST', body: JSON.stringify({ request_id: randomUUID(), task, thread_id: threadId }) }, await accessTokenFor(env), env)
}
export async function getAgentRun(tokens: CliTokens, runId: string, env = process.env) {
  return json<{ run_id: string; request_id: string; status: string; tier: string; max_steps: number; current_step: number; expires_at: string }>(`/agent/runs/${encodeURIComponent(runId)}`, {}, await accessTokenFor(env), env)
}
export async function planAgentStep(tokens: CliTokens, runId: string, task: string, context: string, env = process.env, signal?: AbortSignal) {
  return json<{ kind: 'assistant' | 'action'; text?: string; action_id?: string; action_type?: string; payload?: Record<string, unknown>; payload_hash?: string; reservation_id?: string }>(`/agent/runs/${encodeURIComponent(runId)}/plan`, { method: 'POST', body: JSON.stringify({ task, context }), signal }, await accessTokenFor(env), env)
}
export async function runSubagents(tokens: Pick<CliTokens, 'access_token'>, runId: string, actionId: string, tasks: Array<{ id: string; task: string }>, context: string, env = process.env, signal?: AbortSignal) {
  return json<{ run_id: string; results: Array<{ id: string; summary: string; usage: number }>; active: number; max_active: number }>(`/agent/runs/${encodeURIComponent(runId)}/subagents`, { method: 'POST', body: JSON.stringify({ action_id: actionId, tasks, context: context.slice(0, 8_000) }), signal }, await accessTokenFor(env), env)
}
export async function completeAgentRun(tokens: CliTokens, runId: string, env = process.env) {
  return json<{ status: string }>(`/agent/runs/${encodeURIComponent(runId)}/complete`, { method: 'POST' }, await accessTokenFor(env), env)
}
export async function cancelAgentRun(tokens: CliTokens, runId: string, env = process.env) {
  return json<{ status: string }>(`/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }, await accessTokenFor(env), env)
}

export const uuid = randomUUID
export type { PublicTier }
