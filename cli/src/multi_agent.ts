import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepositoryMetadata } from './repository.js'
import { WorktreeManager, type WorktreeRecord } from './worktrees.js'

const exec = promisify(execFile)
export type MutatingWorker = { id: string; task: string; worktree: WorktreeRecord; status: 'active' | 'completed' | 'failed' | 'applied' | 'discarded'; diff?: string; changed_files: string[]; error?: string }

async function git(args: string[], cwd: string): Promise<string> {
  return (await exec('git', args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 15_000 })).stdout
}
async function diffIncludingUntracked(cwd: string, status: string): Promise<string> {
  let diff = await git(['-c', 'core.pager=cat', '-c', 'diff.external=', 'diff', '--no-ext-diff'], cwd)
  for (const line of status.split(/\r?\n/).filter(value => value.startsWith('?? '))) {
    const path = line.slice(3)
    try { await git(['diff', '--no-index', '--binary', '--', '/dev/null', path], cwd) } catch (error) { diff += String((error as { stdout?: string }).stdout ?? '') }
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
      const status = await git(['status', '--porcelain=v1'], worker.worktree.path), diff = await diffIncludingUntracked(worker.worktree.path, status)
      worker.changed_files = status.split(/\r?\n/).filter(Boolean).map(line => line.slice(3)).slice(0, 200)
      worker.diff = diff.slice(0, 2 * 1024 * 1024); worker.status = 'completed'; return worker
    } catch (error) { worker.status = 'failed'; worker.error = error instanceof Error ? error.message.slice(0, 240) : 'Worker inspection failed.'; return worker }
  }
  list(): MutatingWorker[] { return [...this.workers.values()] }
  async apply(id: string, approve: () => Promise<boolean>): Promise<MutatingWorker> {
    const worker = this.workers.get(id); if (!worker || worker.status !== 'completed' || !worker.diff) throw new Error('Only a completed worker with a reviewable diff can be applied.')
    if ((await git(['status', '--porcelain=v1'], this.metadata.root)).trim()) throw new Error('Primary workspace is dirty; review or commit it before applying a worker diff.')
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
