import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { chmod, lstat, link, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, relative, resolve, win32, posix } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { NetworkPolicy, SandboxAdapter, SandboxPolicy } from './sandbox.js'

const MAX_FILE = 256 * 1024
const MAX_SEARCH_OUTPUT = 128 * 1024
const blocked = /(?:^|\/)\.env(?:$|[./])|(?:^|\/)(?:\.npmrc|\.pypirc|\.ssh|id_(?:rsa|ed25519)|credentials?|secrets?|tokens?|node_modules|dist|build|\.swico|\.git)(?:\/|$)|\.(?:pem|key|p12|pfx|kdbx)$/i
const cleanTerminal = (value: string) => value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
const execFileAsync = promisify(execFile)
const slash = (value: string) => value.replaceAll('\\', '/')

export type SearchOptions = { regex?: boolean; glob?: string; contextLines?: number }
export type FileRange = { path: string; start: number; end: number; text: string; sha256: string }
export type GitStatus = { branch: string | null; head: string | null; dirty: boolean; staged: string[]; unstaged: string[]; untracked: string[] }

function canonicalPath(value: string, platform = process.platform): string {
  const pathApi = platform === 'win32' ? win32 : posix
  let result = pathApi.resolve(value)
  if (platform === 'win32') {
    result = result.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
    result = result.replaceAll('/', '\\\\').replace(/[\\\\]+$/, '').toLowerCase()
  } else {
    result = result.replace(/[\\/]+$/, '') || pathApi.parse(result).root
  }
  return result
}

export function isPathWithinRoot(root: string, candidate: string, platform = process.platform): boolean {
  const normalizedRoot = canonicalPath(root, platform)
  const normalizedCandidate = canonicalPath(candidate, platform)
  if (normalizedRoot === normalizedCandidate) return true
  const separator = platform === 'win32' ? '\\' : '/'
  return normalizedCandidate.startsWith(`${normalizedRoot}${normalizedRoot.endsWith(separator) ? '' : separator}`)
}

function inside(root: string, candidate: string): boolean {
  return isPathWithinRoot(root, candidate)
}

function unifiedPatch(original: string, patch: string): string {
  const source = original.replace(/\r\n/g, '\n').split('\n')
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  let cursor = 0, offset = 0, found = false
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor].startsWith('@@ ')) cursor += 1
    if (cursor >= lines.length) break
    found = true
    const header = lines[cursor++]
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
    if (!match) throw new Error('Patch hunk header is invalid.')
    const oldStart = Number(match[1]), start = (oldStart === 0 ? 0 : oldStart - 1) + offset
    const oldCount = Number(match[2] ?? 1), newCount = Number(match[4] ?? 1), replacement: string[] = [], consumed: string[] = []
    let oldSeen = 0
    while (cursor < lines.length && !lines[cursor].startsWith('@@ ')) {
      const line = lines[cursor++]
      if (line === '' && cursor === lines.length) break
      if (line === '\\ No newline at end of file') continue
      if (!/^[ +\-]/.test(line)) throw new Error('Patch contains an invalid hunk line.')
      if (line[0] !== '+') { oldSeen += 1; consumed.push(line.slice(1)) }
      if (line[0] !== '-') replacement.push(line.slice(1))
    }
    if (oldSeen !== oldCount || replacement.length !== newCount || start < 0 || start + oldCount > source.length) throw new Error('Patch hunk does not match the base file.')
    for (let index = 0; index < consumed.length; index += 1) {
      if (source[start + index] !== consumed[index]) throw new Error('Patch context does not match the base file.')
    }
    source.splice(start, oldCount, ...replacement)
    offset += replacement.length - oldCount
  }
  if (!found) throw new Error('Patch must contain at least one unified hunk.')
  const result = source.join('\n')
  return original.endsWith('\n') && !result.endsWith('\n') ? `${result}\n` : result
}

function hash(data: Uint8Array | string): string { return createHash('sha256').update(data).digest('hex') }

export class Workspace {
  readonly root: string
  constructor(root: string, private readonly sandbox?: SandboxAdapter, private readonly sandboxPolicy: SandboxPolicy = 'workspace-write') { this.root = realpathSync(resolve(root)) }

  private lexicalPath(input: string): string {
    const candidate = resolve(this.root, input)
    const rel = slash(relative(this.root, candidate))
    if (!inside(this.root, candidate)) {
      // Windows can present the same existing file through a short (8.3) or
      // extended-length spelling. Resolve that spelling before applying the
      // root boundary, while leaving the later symlink check authoritative.
      if (process.platform === 'win32') {
        try {
          const native = realpathSync(candidate)
          if (inside(this.root, native)) return candidate
        } catch { /* missing or inaccessible paths remain rejected */ }
      }
      throw new Error('Path is outside the trusted, safe workspace.')
    }
    if (blocked.test(rel)) throw new Error('Path is outside the trusted, safe workspace.')
    return candidate
  }

  private async confined(input: string, allowMissing = false): Promise<string> {
    const candidate = this.lexicalPath(input)
    try {
      const entry = await lstat(candidate)
      if (entry.isSymbolicLink()) throw new Error('Symlinked paths are not allowed.')
      const real = await realpath(candidate)
      if (!inside(this.root, real)) throw new Error('Path resolves outside the trusted workspace.')
      return real
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = await realpath(dirname(candidate))
      if (!inside(this.root, parent)) throw new Error('Path resolves outside the trusted workspace.')
      return candidate
    }
  }

  private assertWritable(): void {
    if (this.sandboxPolicy === 'read-only') throw new Error('The read-only sandbox policy blocks workspace mutations.')
  }

  async listFiles(limit = 200): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('File listing limit is outside the supported bound.')
    const output: string[] = []
    const walk = async (dir: string): Promise<void> => {
      if (output.length >= limit) return
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const full = join(dir, entry.name), rel = slash(relative(this.root, full))
        if (blocked.test(rel) || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) output.push(rel)
        if (output.length >= limit) return
      }
    }
    await walk(this.root)
    return output
  }

  async readFile(path: string): Promise<{ path: string; text: string; sha256: string }> {
    const target = await this.confined(path)
    const info = await lstat(target)
    if (!info.isFile() || info.size > MAX_FILE) throw new Error('Only bounded ordinary text files can be read.')
    const data = await readFile(target)
    if (data.includes(0)) throw new Error('Binary files are not sent to the agent.')
    return { path, text: data.toString('utf8'), sha256: hash(data) }
  }

  async readFileRange(path: string, start: number, end: number): Promise<FileRange> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 2_000) throw new Error('File range is outside the supported bound.')
    const file = await this.readFile(path), all = file.text.split(/\r?\n/)
    return { path, start, end: Math.min(end, all.length), text: all.slice(start - 1, end).join('\n'), sha256: file.sha256 }
  }

  async searchText(term: string, limit = 50, options: SearchOptions = {}): Promise<string[]> {
    if (!term.trim() || term.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Search request is outside the supported bound.')
    const args = [options.regex ? '-e' : '--fixed-strings', ...(options.regex ? [] : ['-e']), term, '--line-number', '--column', '--no-heading', '--color', 'never', '--no-config', '--max-count', String(limit)]
    if (options.contextLines) args.push('-C', String(Math.min(5, Math.max(0, options.contextLines))))
    if (options.glob) {
      if (options.glob.length > 128 || blocked.test(options.glob.replaceAll('\\', '/'))) throw new Error('Search path filter is blocked.')
      args.push('--glob', options.glob)
    }
    args.push('--glob', '!**/.env*', '--glob', '!**/.git/**', '--glob', '!**/.swico/**', '--glob', '!**/node_modules/**', '--glob', '!**/dist/**', '--glob', '!**/build/**', '--glob', '!**/.ssh/**', '--glob', '!**/.npmrc', '--glob', '!**/.pypirc', '--glob', '!**/*credential*/**', '--glob', '!**/*secret*/**', '--glob', '!**/*token*/**', '--glob', '!**/*.{pem,key,p12,pfx,kdbx}', '--', '.')
    try {
      const result = await execFileAsync('rg', args, { cwd: this.root, windowsHide: true, maxBuffer: MAX_SEARCH_OUTPUT, timeout: 10_000, env: commandEnvironment({ RIPGREP_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null' }) })
      return cleanTerminal(result.stdout).split(/\r?\n/).filter(Boolean).slice(0, limit)
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { code?: number; stdout?: string }
      if (failure.code === 1) return []
      if (failure.code === 'ETIMEDOUT') throw new Error('Repository search timed out.')
      if (failure.code !== 'ENOENT') throw new Error('Repository search failed.')
    }
    const hits: string[] = []
    let expression: RegExp | null = null
    if (options.regex) {
      if (/(?:\([^)]{0,256}[+*][^)]*\)|\.\*|\.\+).*(?:[+*]|\.\*|\.\+)/.test(term)) throw new Error('Regex search is too complex for the bounded fallback.')
      try { expression = new RegExp(term, 'u') } catch { throw new Error('Regex search pattern is invalid.') }
    }
    for (const path of await this.listFiles(500)) {
      if (hits.length >= limit) break
      try {
        const file = await this.readFile(path), fileLines = file.text.split(/\r?\n/)
        for (let index = 0; index < fileLines.length && hits.length < limit; index += 1) {
          if (expression ? expression.test(fileLines[index]) : fileLines[index].includes(term)) hits.push(`${path}:${index + 1}:1:${cleanTerminal(fileLines[index]).slice(0, 300)}`)
        }
      } catch { /* blocked/binary files are omitted */ }
    }
    return hits
  }

  private async writeAtomic(path: string, content: string, noClobber = false): Promise<{ path: string; sha256: string }> {
    const target = await this.confined(path, true)
    const existing = await stat(target).catch(() => null)
    const mode = existing?.mode ? existing.mode & 0o7777 : 0o600
    const temporary = `${target}.swico-${process.pid}-${Date.now()}.tmp`
    await writeFile(temporary, content, { mode: mode & 0o7777, flag: 'wx' })
    try {
      await chmod(temporary, mode & 0o7777)
      if (noClobber) { await link(temporary, target); await unlink(temporary) }
      else await rename(temporary, target)
    }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error }
    return { path, sha256: hash(content) }
  }

  async applyPatch(path: string, expectedSha256: string, patch: string, approve: (description: string) => Promise<boolean>): Promise<{ path: string; sha256: string }> {
    this.assertWritable()
    if (patch.length > MAX_FILE) throw new Error('Patch is too large.')
    const current = await this.readFile(path)
    if (current.sha256 !== expectedSha256) throw new Error('File changed since the patch was prepared; refresh context.')
    const proposed = patch.includes('@@ ') ? unifiedPatch(current.text, patch) : patch
    if (Buffer.byteLength(proposed) > MAX_FILE) throw new Error('Resulting file is too large.')
    const preview = [`--- current ${path}`, ...cleanTerminal(current.text).split('\n').map(line => `- ${line}`), `+++ proposed ${path}`, ...cleanTerminal(proposed).split('\n').map(line => `+ ${line}`)].join('\n')
    if (!await approve(`Review the exact proposed patch for ${path}:\n${preview}`)) throw new Error('Edit was not approved.')
    const latest = await this.readFile(path)
    if (latest.sha256 !== expectedSha256) throw new Error('File changed while the patch was awaiting approval; refresh context.')
    return this.writeAtomic(path, proposed)
  }

  async createFile(path: string, content: string, approve: (description: string) => Promise<boolean>): Promise<{ path: string; sha256: string }> {
    this.assertWritable()
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error('File is too large.')
    const target = await this.confined(path, true)
    if (await lstat(target).then(() => true).catch(() => false)) throw new Error('The file already exists; use a patch instead.')
    if (!await approve(`Create ${path}?`)) throw new Error('File creation was not approved.')
    const latest = await this.confined(path, true)
    if (await lstat(latest).then(() => true).catch(() => false)) throw new Error('The file was created while approval was pending; refresh context.')
    return this.writeAtomic(path, content, true)
  }

  async deleteFile(path: string, approve: (description: string) => Promise<boolean>): Promise<void> {
    this.assertWritable()
    const current = await this.readFile(path)
    if (!await approve(`Delete ${path}? This cannot be undone by Swico.`)) throw new Error('File deletion was not approved.')
    const latest = await this.readFile(path)
    if (latest.sha256 !== current.sha256) throw new Error('File changed while deletion was awaiting approval; refresh context.')
    await unlink(await this.confined(path))
  }

  async moveFile(from: string, to: string, approve: (description: string) => Promise<boolean>): Promise<void> {
    this.assertWritable()
    const current = await this.readFile(from), source = await this.confined(from), target = await this.confined(to, true)
    if (await lstat(target).then(() => true).catch(() => false)) throw new Error('The destination already exists.')
    if (!await approve(`Move ${from} to ${to}?`)) throw new Error('File move was not approved.')
    const latest = await this.readFile(from)
    if (latest.sha256 !== current.sha256) throw new Error('File changed while move was awaiting approval; refresh context.')
    const destination = await this.confined(to, true)
    if (await lstat(destination).then(() => true).catch(() => false)) throw new Error('The destination was created while move was awaiting approval; refresh context.')
    // A hard-link followed by unlink gives regular-file moves no-clobber
    // semantics across the approval boundary. Directory moves are deliberately
    // unsupported until an equivalent atomic, cross-platform primitive exists.
    await link(source, destination)
    try { await unlink(source) } catch (error) { await unlink(destination).catch(() => undefined); throw error }
  }

  async gitStatus(): Promise<GitStatus> {
    const status = await this.git(['status', '--porcelain=v1'])
    const staged: string[] = [], unstaged: string[] = [], untracked: string[] = []
    for (const line of status.split(/\r?\n/).filter(Boolean)) {
      const code = line.slice(0, 2), path = line.slice(3)
      if (code === '??') untracked.push(path)
      else { if (code[0] !== ' ') staged.push(path); if (code[1] !== ' ') unstaged.push(path) }
    }
    return { branch: await this.git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null), head: await this.git(['rev-parse', '--verify', 'HEAD']).catch(() => null), dirty: Boolean(status), staged, unstaged, untracked }
  }

  async gitDiff(ref?: string): Promise<string> {
    if (ref !== undefined && (!ref || ref.startsWith('-') || ref.length > 256 || /[\u0000\r\n]/.test(ref))) throw new Error('Git diff reference is invalid.')
    return this.git(ref ? ['-c', 'core.pager=cat', '-c', 'diff.external=', 'diff', '--no-ext-diff', ref] : ['-c', 'core.pager=cat', '-c', 'diff.external=', 'diff', '--no-ext-diff'])
  }

  private async git(args: string[]): Promise<string> {
    try { return (await execFileAsync('git', args, { cwd: this.root, windowsHide: true, maxBuffer: MAX_SEARCH_OUTPUT, timeout: 10_000, env: commandEnvironment({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1' }) })).stdout.trim() }
    catch { throw new Error('Git is unavailable or this workspace is not a repository.') }
  }

  async runCommand(argv: string[], timeoutMs: number, approve: (description?: string) => Promise<boolean>, signal?: AbortSignal, network: NetworkPolicy = 'disabled'): Promise<{ code: number | null; stdout: string; stderr: string; timed_out: boolean; cancelled: boolean; elapsed_ms: number }> {
    if (!argv.length || argv.length > 32 || argv.some(value => value.length > 512)) throw new Error('Command arguments are outside the bounded policy.')
    if (!await approve(`Run ${argv.join(' ')} in ${this.root} (network: ${network})?`)) throw new Error('Command was not approved.')
    const started = Date.now()
    return new Promise((resolveResult, reject) => {
      let child: ChildProcess
      try {
        const environment = { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', SystemRoot: process.env.SystemRoot ?? '', ComSpec: process.env.ComSpec ?? '' }
        child = this.sandbox
          ? this.sandbox.spawn([argv[0], ...argv.slice(1)], { cwd: this.root, shell: false, detached: process.platform !== 'win32', env: environment, policy: this.sandboxPolicy, network })
          : spawn(argv[0], argv.slice(1), { cwd: this.root, shell: false, detached: process.platform !== 'win32', env: environment })
      } catch (error) { reject(error); return }
      let stdout = '', stderr = '', timedOut = false, cancelled = false, settled = false, forceTimer: NodeJS.Timeout | undefined
      const cap = 128 * 1024
      const stop = (reason: 'timeout' | 'cancel') => {
        if (reason === 'timeout') timedOut = true
        if (reason === 'cancel') cancelled = true
        if (process.platform === 'win32') child.kill()
        else if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
        forceTimer = setTimeout(() => {
          if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => undefined)
          else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
        }, 750)
      }
      const timer = setTimeout(() => stop('timeout'), Math.max(100, Math.min(timeoutMs, 120_000)))
      const abort = () => stop('cancel')
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
      child.stdout?.on('data', chunk => { stdout = (stdout + cleanTerminal(String(chunk))).slice(0, cap) })
      child.stderr?.on('data', chunk => { stderr = (stderr + cleanTerminal(String(chunk))).slice(0, cap) })
      child.on('error', error => { if (!settled) { settled = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); reject(error) } })
      child.on('close', code => { if (settled) return; settled = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); signal?.removeEventListener('abort', abort); resolveResult({ code, stdout, stderr, timed_out: timedOut, cancelled, elapsed_ms: Date.now() - started }) })
    })
  }
}

function commandEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
    HOME: process.env.HOME ?? '',
    SystemRoot: process.env.SystemRoot ?? '',
    ...extra,
  }
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== ''))
}

export { cleanTerminal }
