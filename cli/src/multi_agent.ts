import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { RepositoryMetadata } from './repository.js'
import { WorktreeManager, type WorktreeRecord } from './worktrees.js'
import type { AgentAction, AgentResult } from './contracts.js'
import type { LocalAgent } from './agent.js'

const exec = promisify(execFile)
export type MutatingWorker = { id: string; task: string; worktree: WorktreeRecord; status: 'active' | 'completed' | 'failed' | 'applied' | 'discarded'; diff?: string; diff_hash?: string; changed_files: string[]; error?: string }

async function git(args: string[], cwd: string): Promise<string> {
  return (await exec('git', args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 15_000 })).stdout
}
function porcelainEntries(status: string): string[] { return status.split('\0').filter(Boolean) }
function untrackedPaths(status: string): string[] {
  return porcelainEntries(status).filter(value => value.startsWith('?? ')).map(value => value.slice(3))
}
function changedPaths(status: string): string[] {
  const entries = porcelainEntries(status), paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index], code = entry.slice(0, 2), path = entry.length >= 3 && entry[2] === ' ' ? entry.slice(3) : entry
    if (!path) continue
    paths.push(path)
    if (code.includes('R') || code.includes('C')) {
      const destination = entries[index + 1]
      if (destination && !/^.. /.test(destination)) { paths.push(destination); index += 1 }
    }
  }
  return paths
}
async function diffIncludingUntracked(cwd: string, status: string): Promise<string> {
  // HEAD includes staged and unstaged tracked changes. The base comparison
  // also includes changes committed inside the detached worker worktree.
  let diff = await git(['-c', 'core.pager=cat', '-c', 'diff.external=', 'diff', '--no-ext-diff', 'HEAD'], cwd).catch(() => '')
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  for (const path of untrackedPaths(status)) {
    try { await git(['diff', '--no-index', '--binary', '--', nullDevice, path], cwd) } catch (error) { diff += String((error as { stdout?: string }).stdout ?? '') }
  }
  return diff
}

/** Coordinates isolated, review-first workers; never mutates the primary tree implicitly. */
export class MutatingWorkerCoordinator {
  private readonly workers = new Map<string, MutatingWorker>()
  private readonly statePath: string
  constructor(private readonly metadata: RepositoryMetadata, private readonly env = process.env, private readonly maxWorkers = 4) {
    this.statePath = env.SWICO_CLI_WORKERS_FILE ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'swico', 'workers.json')
    try {
      const saved = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (Array.isArray(saved)) for (const value of saved) {
        if (!value || typeof value !== 'object' || (value as MutatingWorker).worktree?.repository_identity !== metadata.root) continue
        const worker = value as MutatingWorker
        // An in-flight worker cannot safely be resumed across processes. Keep
        // its owned worktree and journal reviewable, but never replay an
        // action whose acknowledgement may have been lost.
        if (worker.status === 'active') { worker.status = 'failed'; worker.error = 'Worker controller restarted; no mutation was replayed. Review or discard its worktree.' }
        this.workers.set(worker.id, worker)
      }
    } catch { /* absent or malformed local state is treated as no workers */ }
  }
  private async persist(): Promise<void> {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify([...this.workers.values()])}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, this.statePath)
  }
  async start(task: string): Promise<MutatingWorker> {
    if (!task || task.length > 2_000) throw new Error('Worker task is outside the supported bound.')
    if ([...this.workers.values()].filter(item => item.status === 'active').length >= this.maxWorkers) throw new Error(`At most ${this.maxWorkers} mutating workers may be active.`)
    const id = randomUUID(), worktree = await new WorktreeManager(this.metadata, this.env).create(`worker:${id}`)
    const worker: MutatingWorker = { id, task, worktree, status: 'active', changed_files: [] }
    this.workers.set(id, worker); await this.persist(); return worker
  }
  async complete(id: string): Promise<MutatingWorker> {
    const worker = this.workers.get(id); if (!worker || worker.status !== 'active') throw new Error('Worker is not active.')
    try {
      const status = await git(['status', '--porcelain=v1', '-z'], worker.worktree.path), diff = `${await git(['diff', '--binary', '--no-ext-diff', `${worker.worktree.base_commit}..HEAD`], worker.worktree.path).catch(() => '')}${await diffIncludingUntracked(worker.worktree.path, status)}`
      worker.changed_files = changedPaths(status).slice(0, 500)
      if (Buffer.byteLength(diff) > 2 * 1024 * 1024) throw new Error('Worker diff exceeds the reviewable artifact bound; it was not truncated.')
      worker.diff = diff; worker.diff_hash = createHash('sha256').update(diff).digest('hex'); worker.status = 'completed'; await this.persist(); return worker
    } catch (error) { worker.status = 'failed'; worker.error = error instanceof Error ? error.message.slice(0, 240) : 'Worker inspection failed.'; await this.persist(); return worker }
  }
  /**
   * Run a worker through the same action executor as the root agent. The
   * planner callback is intentionally injected so callers can use the
   * server-authoritative planner without making this coordinator a second
   * provider/billing implementation.
   */
  async executeLoop(
    id: string,
    agent: LocalAgent,
    planner: (context: string, signal?: AbortSignal) => Promise<AgentAction | { kind: 'assistant'; text: string }>,
    approve: (description: string) => Promise<boolean>,
    signal?: AbortSignal,
    maxSteps = 8,
    serverRunId = id,
  ): Promise<MutatingWorker> {
    const worker = this.workers.get(id)
    if (!worker || worker.status !== 'active') throw new Error('Worker is not active.')
    const observations: string[] = []
    try {
      for (let step = 0; step < Math.min(32, Math.max(1, maxSteps)); step += 1) {
        if (signal?.aborted) throw new Error('Worker was cancelled.')
        const next = await planner(observations.join('\n').slice(-48_000), signal)
        if ('kind' in next && next.kind === 'assistant') {
          observations.push(`assistant: ${next.text.slice(0, 8_000)}`); return await this.complete(id)
        }
        if (!('action_type' in next)) throw new Error('Planner returned an unsupported worker action.')
        const result: AgentResult = await agent.execute(serverRunId, next, approve)
        observations.push(`${next.action_type}: ${JSON.stringify(result.result).slice(0, 10_000)}`)
        if (result.status === 'unknown') throw new Error('Worker action outcome is unknown; inspect its journal before retrying.')
      }
      throw new Error('Worker step limit reached without a completed result.')
    } catch (error) {
      worker.status = 'failed'; worker.error = error instanceof Error ? error.message.slice(0, 240) : 'Worker failed.'; await this.persist(); return worker
    }
  }
  list(): MutatingWorker[] { return [...this.workers.values()] }
  async apply(id: string, approve: () => Promise<boolean>): Promise<MutatingWorker> {
    const worker = this.workers.get(id); if (!worker || worker.status !== 'completed' || !worker.diff) throw new Error('Only a completed worker with a reviewable diff can be applied.')
    if ((await git(['status', '--porcelain=v1'], this.metadata.root)).trim()) throw new Error('Primary workspace is dirty; review or commit it before applying a worker diff.')
    if (!worker.diff_hash || createHash('sha256').update(worker.diff).digest('hex') !== worker.diff_hash) throw new Error('Worker review artifact changed; fresh review is required.')
    if (!await approve()) throw new Error('Applying the worker diff was not approved.')
    await new Promise<void>((resolve, reject) => {
      const child = execFile('git', ['apply', '--3way', '--whitespace=nowarn', '-'], { cwd: this.metadata.root, windowsHide: true }, error => error ? reject(error) : resolve())
      child.stdin?.end(worker.diff)
    })
    worker.status = 'applied'; await this.persist(); return worker
  }
  async discard(id: string, approve: () => Promise<boolean>): Promise<void> {
    const worker = this.workers.get(id); if (!worker) throw new Error('Unknown worker.')
    if (!await approve()) throw new Error('Discarding the worker was not approved.')
    await new WorktreeManager(this.metadata, this.env).clean(worker.worktree.id, async () => true); worker.status = 'discarded'; await this.persist()
  }
}
