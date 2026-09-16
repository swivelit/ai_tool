import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { SandboxAdapter } from './sandbox.js'

export type HookEvent = 'session_start' | 'session_end' | 'user_prompt' | 'pre_tool' | 'post_tool' | 'permission_request' | 'pre_compact' | 'post_compact' | 'subagent_start' | 'subagent_stop'
export type HookPayload = { event: HookEvent; run_id?: string; action_type?: string; summary?: string }
export class HookBus { private listeners = new Map<HookEvent, Array<(payload: HookPayload) => void | Promise<void>>>() ; on(event: HookEvent, listener: (payload: HookPayload) => void | Promise<void>): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]) }; async emit(payload: HookPayload): Promise<void> { for (const listener of this.listeners.get(payload.event) ?? []) await listener(payload) } }
export type ExecutableHook = { event: HookEvent; command: string; args?: string[]; trusted: boolean; approvedHash: string; allowedEnv?: string[] }
export type HookRunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
const MAX_OUTPUT = 64 * 1024
const safeEnv = (names: string[] = []): NodeJS.ProcessEnv => Object.fromEntries(names.filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/token|secret|password|key|credential/i.test(name)).map(name => [name, process.env[name] ?? '']).concat([['PATH', process.env.PATH ?? '']]))
export async function executableHookHash(hook: Pick<ExecutableHook, 'command' | 'args' | 'event' | 'allowedEnv'>): Promise<string> {
  const info = await lstat(hook.command)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Hook command must be a regular file.')
  const content = await readFile(hook.command)
  return createHash('sha256').update(JSON.stringify({ command: hook.command, args: hook.args ?? [], event: hook.event, allowedEnv: hook.allowedEnv ?? [], content: content.toString('base64') })).digest('hex')
}
export async function runExecutableHook(hook: ExecutableHook, payload: HookPayload, sandbox: SandboxAdapter, sandboxVerified: boolean, signal?: AbortSignal): Promise<HookRunResult> {
  if (!hook.trusted) throw new Error('Executable hooks require explicit trust.')
  if (!sandboxVerified || !sandbox.status().available) throw new Error('Executable hooks require verified sandbox confinement.')
  if (await executableHookHash(hook) !== hook.approvedHash) throw new Error('Hook content or configuration changed; trust is invalid.')
  const wrapped = sandbox.wrap([hook.command, ...(hook.args ?? [])], 'read-only', 'disabled')
  return await new Promise((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.args, { cwd: process.cwd(), env: safeEnv(hook.allowedEnv), shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', settled = false
    const finish = (result: HookRunResult) => { if (!settled) { settled = true; resolve(result) } }
    const kill = () => { if (child.pid) { try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } } }
    const timer = setTimeout(() => { kill(); finish({ code: null, signal: 'SIGTERM', stdout, stderr: `${stderr}\nHook timed out.`.slice(-MAX_OUTPUT) }) }, 15_000)
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => { if (target === 'stdout') stdout = `${stdout}${chunk.toString()}`.slice(0, MAX_OUTPUT); else stderr = `${stderr}${chunk.toString()}`.slice(0, MAX_OUTPUT) }
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'))
    child.on('error', error => { clearTimeout(timer); if (!settled) { settled = true; reject(error) } })
    child.on('close', (code, closeSignal) => { clearTimeout(timer); finish({ code, signal: closeSignal, stdout, stderr }) })
    const abort = () => kill(); if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    child.stdin.end(JSON.stringify({ event: payload.event, run_id: payload.run_id, action_type: payload.action_type, summary: payload.summary }))
  })
}
export function hookStatus(enabled = false): { enabled: boolean; execution: 'disabled' | 'approval-required' } { return { enabled, execution: enabled ? 'approval-required' : 'disabled' } }
