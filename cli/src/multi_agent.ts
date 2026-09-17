import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
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
async function diffIncludingUntracked(cwd: string, status: string): Promise<string> {
  // HEAD includes staged and unstaged tracked changes. The base comparison
  // also includes changes committed inside the detached worker worktree.
  let diff = await git(['-c', 'core.pager=cat', '-c', 'diff.external=', 'diff', '--no-ext-diff', 'HEAD'], cwd).catch(() => '')
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  for (const line of status.split(/\r?\n/).filter(value => value.startsWith('?? '))) {
    const path = line.slice(3)
    try { await git(['diff', '--no-index', '--binary', '--', nullDevice, path], cwd) } catch (error) { diff += String((error as { stdout?: string }).stdout ?? '') }
  }
  return diff
}

/** Coordinates isolated, review-first workers; never mutates the primary tree implicitly. */
export class MutatingWorkerCoordinator {
  private readonly workers = new Map<string, MutatingWorker>()
  constructor(private readonly metadata: RepositoryMetadata, private readonly env = process.env, private readonly maxWorkers = 4) {}
  async start(task: string): Promise<MutatingWorker> {
    if (!task || task.length > 2_000) throw new Error('Worker task is outside the supported bound.')
    if ([...this.workers.values()].filter(item => item.status === 'active').length >= this.maxWorkers) throw new Error(`At most ${this.maxWorkers} mutating workers may be active.`)
    const id = randomUUID(), worktree = await new WorktreeManager(this.metadata, this.env).create(`worker:${id}`)
    const worker: MutatingWorker = { id, task, worktree, status: 'active', changed_files: [] }
    this.workers.set(id, worker); return worker
  }
  async complete(id: string): Promise<MutatingWorker> {
    const worker = this.workers.get(id); if (!worker || worker.status !== 'active') throw new Error('Worker is not active.')
    try {
      const status = await git(['status', '--porcelain=v1'], worker.worktree.path), diff = `${await git(['diff', '--binary', '--no-ext-diff', `${worker.worktree.base_commit}..HEAD`], worker.worktree.path).catch(() => '')}${await diffIncludingUntracked(worker.worktree.path, status)}`
      worker.changed_files = status.split(/\r?\n/).filter(Boolean).map(line => line.slice(3).replace(/^"|"$/g, '')).slice(0, 500)
      if (Buffer.byteLength(diff) > 2 * 1024 * 1024) throw new Error('Worker diff exceeds the reviewable artifact bound; it was not truncated.')
      worker.diff = diff; worker.diff_hash = createHash('sha256').update(diff).digest('hex'); worker.status = 'completed'; return worker
    } catch (error) { worker.status = 'failed'; worker.error = error instanceof Error ? error.message.slice(0, 240) : 'Worker inspection failed.'; return worker }
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
        const result: AgentResult = await agent.execute(id, next, approve)
        observations.push(`${next.action_type}: ${JSON.stringify(result.result).slice(0, 10_000)}`)
        if (result.status === 'unknown') throw new Error('Worker action outcome is unknown; inspect its journal before retrying.')
      }
      throw new Error('Worker step limit reached without a completed result.')
    } catch (error) {
      worker.status = 'failed'; worker.error = error instanceof Error ? error.message.slice(0, 240) : 'Worker failed.'; return worker
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
    worker.status = 'applied'; return worker
  }
  async discard(id: string, approve: () => Promise<boolean>): Promise<void> {
    const worker = this.workers.get(id); if (!worker) throw new Error('Unknown worker.')
    if (!await approve()) throw new Error('Discarding the worker was not approved.')
    await new WorktreeManager(this.metadata, this.env).clean(worker.worktree.id, async () => true); worker.status = 'discarded'
  }
}
