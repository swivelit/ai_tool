import { createHash, randomUUID } from 'node:crypto'
import { apiBaseUrl, cliApi } from './config.js'
import { SSEParser, type SSEEvent } from './sse.js'
import type { CliTokens, PublicTier } from './contracts.js'

export class CliApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message) }
}

export async function probeEndpoint(env = process.env): Promise<{ status: number; state: 'enabled' | 'disabled' | 'unavailable' | 'unexpected'; detail?: string }> {
  try {
    const response = await fetch(`${apiBaseUrl(env)}/api/cli/v1/device/__doctor__`, { headers: { Accept: 'application/json' }, redirect: 'error' })
    const text = (await response.text()).slice(0, 500)
    if (text.trimStart().startsWith('<')) return { status: response.status, state: 'unexpected', detail: 'The endpoint returned HTML instead of the Swico API.' }
    let detail = ''
    try {
      const body = JSON.parse(text) as { detail?: { code?: string; message?: string } | string }
      detail = typeof body.detail === 'string' ? body.detail : body.detail?.message ?? body.detail?.code ?? ''
      if (body.detail && typeof body.detail === 'object' && body.detail.code === 'cli_disabled') return { status: response.status, state: 'disabled', detail }
    } catch { /* HTML/proxy responses are classified below */ }
    if (response.status === 404) return { status: response.status, state: 'enabled', detail: detail || 'CLI endpoint responded; authentication is required.' }
    if (response.ok) return { status: response.status, state: 'enabled', detail: detail || 'Endpoint responded.' }
    return { status: response.status, state: 'unexpected', detail: detail || `HTTP ${response.status}` }
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

export async function createDevice(verifier: string, scopes: string[], env = process.env) {
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return json<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }>('/device', {
    method: 'POST', body: JSON.stringify({ client_id: 'swico-cli', code_challenge: challenge, device_description: `Swico CLI on ${process.platform}`, scopes }),
  }, undefined, env)
}

export async function exchangeDevice(deviceCode: string, verifier: string, env = process.env): Promise<CliTokens> {
  return json<CliTokens>('/token', { method: 'POST', body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode, code_verifier: verifier }) }, undefined, env)
}

export async function refresh(refreshToken: string, env = process.env): Promise<CliTokens> {
  return json<CliTokens>('/token', { method: 'POST', body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }) }, undefined, env)
}

export async function streamChat(tokens: CliTokens, message: string, threadId?: string, onEvent?: (event: SSEEvent) => void, env = process.env): Promise<{ threadId: string | null; text: string }> {
  const requestId = randomUUID()
  const response = await fetch(cliApi('/chat/stream', env), { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ request_id: requestId, message, thread_id: threadId, input_mode: 'text' }) })
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

export async function createAgentRun(tokens: CliTokens, task: string, threadId?: string, env = process.env) {
  return json<{ run_id: string; max_steps: number }>('/agent/runs', { method: 'POST', body: JSON.stringify({ request_id: randomUUID(), task, thread_id: threadId }) }, tokens.access_token, env)
}
export async function planAgentStep(tokens: CliTokens, runId: string, task: string, context: string, env = process.env) {
  return json<{ kind: 'assistant' | 'action'; text?: string; action_id?: string; action_type?: string; payload?: Record<string, unknown>; payload_hash?: string }>(`/agent/runs/${encodeURIComponent(runId)}/plan`, { method: 'POST', body: JSON.stringify({ task, context }) }, tokens.access_token, env)
}
export async function completeAgentRun(tokens: CliTokens, runId: string, env = process.env) {
  return json<{ status: string }>(`/agent/runs/${encodeURIComponent(runId)}/complete`, { method: 'POST' }, tokens.access_token, env)
}
export async function cancelAgentRun(tokens: CliTokens, runId: string, env = process.env) {
  return json<{ status: string }>(`/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }, tokens.access_token, env)
}

export const uuid = randomUUID
export type { PublicTier }
