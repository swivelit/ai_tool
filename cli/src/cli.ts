#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { createInterface, type Interface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { clearTokens, credentialStorageDescription, loadTokens, saveTokens, CredentialStorageUnavailableError } from './credentials.js'
import { cancelAgentRun, completeAgentRun, createAgentRun, createDevice, exchangeDevice, json, planAgentStep, probeEndpoint, streamChat } from './api.js'
import type { AgentAction, CliTokens } from './contracts.js'
import { LocalAgent } from './agent.js'
import { Workspace } from './workspace.js'
import type { SSEEvent } from './sse.js'
import { ensureTokens } from './session.js'
import { credentialKey } from './config.js'

const exec = promisify(execFile)
const packageJson = createRequire(import.meta.url)('../package.json') as { version?: string }
const VERSION = packageJson.version ?? 'unknown'
function showStreamEvent(event: SSEEvent) {
  if (event.event === 'status') process.stdout.write(`\n[${JSON.stringify(event.data)}] `)
  if (event.event === 'sources' && event.data && typeof event.data === 'object' && 'sources' in event.data) {
    const sources = (event.data as { sources?: unknown }).sources
    if (Array.isArray(sources)) process.stdout.write(`\nSources: ${sources.map(source => source && typeof source === 'object' ? String((source as { label?: unknown }).label ?? '') : '').filter(Boolean).join(', ') || 'available'} `)
  }
  if (event.event === 'quality' && event.data && typeof event.data === 'object' && 'status' in event.data) {
    process.stdout.write(`\nQuality: ${String((event.data as { status?: unknown }).status ?? 'reported')} `)
  }
}
const help = `Swico ${VERSION}\n\nUsage: swico [command]\n\nCommands:\n  login       Sign in with your existing Swico account\n  logout      Revoke this terminal session\n  whoami      Show the signed-in account and tier\n  ask TEXT    Ask a question\n  resume      Show saved server conversations\n  doctor      Check endpoint and stored session\n\nInteractive commands: /help /new /history /resume /model /mode /usage /status /agent /diff /exit`

async function openBrowser(url: string) {
  try { if (process.platform === 'darwin') await exec('open', [url]); else if (process.platform === 'win32') await exec('cmd', ['/c', 'start', '', url]); else await exec('xdg-open', [url]) } catch { /* manual URL is always displayed */ }
}
function verifier() { return randomBytes(48).toString('base64url') }
async function login(env = process.env, scopes = ['chat'], options: { memoryOnly?: boolean } = {}): Promise<CliTokens> {
  const value = verifier(); const device = await createDevice(value, scopes, env)
  console.log(`\nOpen ${device.verification_uri} and enter code ${device.user_code}.`)
  console.log(`Verification URL: ${device.verification_uri_complete}`); await openBrowser(device.verification_uri_complete)
  const deadline = Date.now() + device.expires_in * 1000; let wait = Math.max(5, device.interval) * 1000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, wait))
    try {
      const tokens = await exchangeDevice(device.device_code, value, env)
      const storage = await saveTokens(tokens, env, options)
      console.log(`Signed in as ${tokens.account.email ?? tokens.account.name} (${tokens.tier_label}).`)
      console.log(storage === 'memory' ? 'Session storage: memory only; it will not survive process exit.' : `Session storage: ${storage}.`)
      return tokens
    }
    catch (error) {
      if (error instanceof CredentialStorageUnavailableError) throw error
      const body = error && typeof error === 'object' && 'body' in error ? (error as { body?: unknown }).body : null
      const code = typeof body === 'object' && body && 'detail' in body && typeof (body as { detail: unknown }).detail === 'object' ? String(((body as { detail: { error?: unknown } }).detail).error ?? '') : ''
      if (code === 'authorization_pending') continue
      if (code === 'slow_down') { wait += 5_000; continue }
      if (code === 'access_denied') throw new Error('The terminal authorization was denied in the browser.')
      if (code === 'expired_token') throw new Error('The terminal authorization expired. Run `swico login` again.')
      throw error
    }
  }
  throw new Error('The sign-in request expired. Run swico login again.')
}
async function interactive(tokens: CliTokens, env = process.env) {
  const line = createInterface({ input, output }); let thread: string | undefined
  console.log(`Swico ${VERSION} · ${tokens.account.email ?? 'account'} · ${tokens.tier_label} · ${process.cwd()} · session ${tokens.session_id}`)
  try {
    for (;;) {
      const value = (await line.question('you> ')).trim(); if (!value) continue
      if (value === '/exit') break
      if (value === '/help') { console.log(help); continue }
      if (value === '/new') { thread = undefined; console.log('Started a new chat.'); continue }
      if (value === '/whoami' || value === '/status') { console.log(JSON.stringify(await json('/me', {}, tokens.access_token, env), null, 2)); continue }
      if (value === '/history' || value === '/resume') { console.log(JSON.stringify(await json('/threads', {}, tokens.access_token, env), null, 2)); continue }
      if (value === '/model' || value === '/mode') { console.log(`${tokens.tier_label} (server-selected)`); continue }
      if (value === '/usage') { console.log(JSON.stringify(await json('/usage', {}, tokens.access_token, env), null, 2)); continue }
      if (value === '/diff') { console.log(`Local action journal: ${env.SWICO_CLI_JOURNAL_FILE ?? `${process.cwd()}/.swico/action-journal.jsonl`}`); continue }
      if (value === '/agent' || value.startsWith('/agent ')) {
        const task = value.slice('/agent'.length).trim()
        if (!task) { console.log('Usage: /agent TASK'); continue }
        await runAgent(tokens, task, env, line)
        continue
      }
      const answer = await streamChat(tokens, value, thread, showStreamEvent, env)
      thread = answer.threadId ?? thread; console.log(`\n${answer.text}`)
    }
  } finally { line.close() }
}
async function runAgent(tokens: CliTokens, task: string, env = process.env, lineOverride?: Interface) {
  const workspace = new Workspace(env.SWICO_CLI_WORKSPACE ?? process.cwd())
  const line = lineOverride ?? createInterface({ input, output })
  const ownsLine = !lineOverride
  let runId: string | undefined
  try {
    if (!await line.question(`Trust ${workspace.root} and send selected file context to Swico? (y/N) `).then(value => /^y(es)?$/i.test(value.trim()))) {
      throw new Error('Workspace trust was not granted; no local content was sent.')
    }
    const run = await createAgentRun(tokens, task, undefined, env); runId = run.run_id
    let context = (await workspace.listFiles(100)).join('\n')
    const agent = new LocalAgent(workspace, tokens.access_token, env)
    for (let step = 0; step < run.max_steps; step += 1) {
      const plan = await planAgentStep(tokens, run.run_id, task, context.slice(-19_000), env)
      if (plan.kind === 'assistant') { console.log(plan.text ?? ''); await completeAgentRun(tokens, run.run_id, env); runId = undefined; return }
      if (!plan.action_id || !plan.action_type || !plan.payload) throw new Error('The server returned an incomplete action.')
      const action: AgentAction = {
        protocol_version: 1, action_id: plan.action_id,
        action_type: plan.action_type as AgentAction['action_type'],
        payload: plan.payload, payload_hash: plan.payload_hash,
      }
      const result = await agent.execute(run.run_id, action, async description => /^y(es)?$/i.test((await line.question(`${description} (y/N) `)).trim()))
      console.log(result.status === 'succeeded' ? JSON.stringify(result.result, null, 2) : String(result.result))
      if (result.status !== 'succeeded') return
      context = `${context}\nACTION ${action.action_type} RESULT (untrusted local observation):\n${JSON.stringify(result.result)}`
    }
    await completeAgentRun(tokens, run.run_id, env); runId = undefined
    console.log('The bounded agent reached its server-advertised step limit.')
  } catch (error) {
    if (runId) await cancelAgentRun(tokens, runId, env).catch(() => undefined)
    throw error
  } finally { if (ownsLine) line.close() }
}
async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(help); return 0 }
  if (argv.includes('--version') || argv.includes('-v')) { console.log(VERSION); return 0 }
  const command = argv[0]
  if (command === 'login') { await login(env, argv.includes('--agent') ? ['chat', 'agent'] : ['chat'], { memoryOnly: argv.includes('--memory-only') }); return 0 }
  if (command === 'logout') { const tokens = await loadTokens(env); if (tokens) await json('/logout', { method: 'POST' }, tokens.access_token, env).catch(() => undefined); await clearTokens(env); console.log('Signed out.'); return 0 }
  if (command === 'doctor') {
    const endpoint = (() => { try { return credentialKey(env) } catch (error) { return error instanceof Error ? `invalid: ${error.message}` : 'invalid' } })()
    const tokens = await loadTokens(env)
    const api = env.SWICO_CLI_DOCTOR_OFFLINE === '1' ? { status: 0, state: 'not_checked', detail: 'offline artifact check' } : await probeEndpoint(env)
    let auth: 'not_configured' | 'valid' | 'expired_or_revoked' | 'network_error' = tokens ? 'expired_or_revoked' : 'not_configured'
    if (tokens) {
      try { await json('/me', {}, tokens.access_token, env); auth = 'valid' }
      catch (error) { auth = (error as { status?: number }).status === 401 ? 'expired_or_revoked' : 'network_error' }
    }
    console.log(JSON.stringify({ endpoint, api, auth, credential_storage: credentialStorageDescription(env) }, null, 2)); return 0
  }
  const tokens = await ensureTokens(env)
  if (command === 'whoami') { console.log(JSON.stringify(await json('/me', {}, tokens.access_token, env), null, 2)); return 0 }
  if (command === 'resume') { console.log(JSON.stringify(await json('/threads', {}, tokens.access_token, env), null, 2)); return 0 }
  if (command === 'ask') { const answer = await streamChat(tokens, argv.slice(1).join(' '), undefined, showStreamEvent, env); console.log(answer.text); return 0 }
  if (command === 'agent') { await runAgent(tokens, argv.slice(1).filter(value => value !== '--agent').join(' '), env); return 0 }
  if (!input.isTTY) throw new Error('This terminal is non-interactive. Use `swico ask "your question"` or another explicit command.')
  await interactive(tokens, env); return 0
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Swico failed.'); process.exitCode = 1 })
