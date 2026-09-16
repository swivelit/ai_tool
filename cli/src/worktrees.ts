import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RepositoryMetadata } from './repository.js'
const exec = promisify(execFile)
export type WorktreeRecord = { id: string; repository_root: string; repository_identity: string; base_commit: string; path: string; branch: string | null; run_id?: string; created_at: string; cleanup_status: 'active' | 'cleaned' }
function stateFile(env: NodeJS.ProcessEnv = process.env): string { return env.SWICO_CLI_WORKTREES_FILE ?? join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'swico', 'worktrees.json') }
async function git(args: string[], cwd: string): Promise<string> { return (await exec('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 })).stdout.trim() }
async function records(env = process.env): Promise<WorktreeRecord[]> { try { return JSON.parse(await readFile(stateFile(env), 'utf8')) as WorktreeRecord[] } catch { return [] } }
async function save(value: WorktreeRecord[], env = process.env): Promise<void> { const file = stateFile(env), temp = `${file}.${randomUUID()}.tmp`; await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(temp, JSON.stringify(value.slice(-100)) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, file) }
export class WorktreeManager {
  constructor(private readonly metadata: RepositoryMetadata, private readonly env = process.env) {}
  async list(): Promise<WorktreeRecord[]> { return (await records(this.env)).filter(item => item.repository_identity === this.metadata.root && item.cleanup_status === 'active') }
  async create(runId?: string): Promise<WorktreeRecord> { if (!this.metadata.gitAvailable || !this.metadata.head) throw new Error('Git worktrees require a repository with a base commit.'); const id = randomUUID(), path = join(this.env.SWICO_CLI_WORKTREE_ROOT ?? join(this.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'swico', 'worktrees'), id); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await git(['worktree', 'add', '--detach', path, this.metadata.head], this.metadata.root); const record: WorktreeRecord = { id, repository_root: this.metadata.root, repository_identity: this.metadata.root, base_commit: this.metadata.head, path, branch: null, run_id: runId, created_at: new Date().toISOString(), cleanup_status: 'active' }; await save([...(await records(this.env)), record], this.env); return record }
  async clean(id: string, confirm: () => Promise<boolean>): Promise<void> { const all = await records(this.env), record = all.find(item => item.id === id && item.repository_identity === this.metadata.root && item.cleanup_status === 'active'); if (!record) throw new Error('Unknown or foreign Swico worktree.'); if (resolve(record.path) === resolve(this.metadata.root)) throw new Error('The primary workspace cannot be removed.'); if (!await confirm()) throw new Error('Worktree cleanup was not approved.'); await git(['worktree', 'remove', '--force', record.path], this.metadata.root); record.cleanup_status = 'cleaned'; await save(all, this.env) }
}
