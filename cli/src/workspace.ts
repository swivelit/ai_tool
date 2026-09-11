import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const MAX_FILE = 256 * 1024
const blocked = /(^|\/)(\.env(?:\.|$)|\.npmrc|\.pypirc|\.ssh|id_(?:rsa|ed25519)|credentials?|secrets?|tokens?|node_modules|dist|build|\.git)(\/|$)|\.(?:pem|key|p12|pfx|kdbx)$/i
const cleanTerminal = (value: string) => value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')

export class Workspace {
  readonly root: string
  constructor(root: string) { this.root = realpathSync(resolve(root)) }
  private path(input: string) {
    const candidate = resolve(this.root, input)
    const rel = relative(this.root, candidate)
    if (rel.startsWith('..') || rel.includes(`${process.platform === 'win32' ? '\\' : '/'}..`) || blocked.test(rel.replaceAll('\\', '/'))) throw new Error('Path is outside the trusted, safe workspace.')
    return candidate
  }
  async listFiles(limit = 200): Promise<string[]> {
    const output: string[] = []
    const walk = async (dir: string): Promise<void> => {
      if (output.length >= limit) return
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const full = join(dir, entry.name); const rel = relative(this.root, full)
        if (blocked.test(rel.replaceAll('\\', '/')) || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) output.push(rel)
        if (output.length >= limit) return
      }
    }
    await walk(this.root); return output
  }
  async readFile(path: string): Promise<{ path: string; text: string; sha256: string }> {
    const target = this.path(path); const stat = await lstat(target)
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Only bounded ordinary text files can be read.')
    const data = await readFile(target); if (data.includes(0)) throw new Error('Binary files are not sent to the agent.')
    return { path, text: data.toString('utf8'), sha256: createHash('sha256').update(data).digest('hex') }
  }
  async searchText(term: string, limit = 50): Promise<string[]> {
    if (!term.trim()) throw new Error('Search text is required.')
    const hits: string[] = []
    for (const path of await this.listFiles()) { if (hits.length >= limit) break; try { const file = await this.readFile(path); if (file.text.includes(term)) hits.push(path) } catch { /* filtered file */ } }
    return hits
  }
  async applyPatch(path: string, expectedSha256: string, content: string, approve: (description: string) => Promise<boolean>): Promise<{ path: string; sha256: string }> {
    if (content.length > MAX_FILE) throw new Error('Patch is too large.')
    const target = this.path(path); const current = await this.readFile(path)
    if (current.sha256 !== expectedSha256) throw new Error('File changed since the patch was prepared; refresh context.')
    const preview = [
      `--- current ${path}`,
      ...cleanTerminal(current.text).split('\n').map(line => `- ${line}`),
      `+++ proposed ${path}`,
      ...cleanTerminal(content).split('\n').map(line => `+ ${line}`),
    ].join('\n')
    if (!await approve(`Review the exact proposed replacement for ${path}:\n${preview}`)) throw new Error('Edit was not approved.')
    const temporary = `${target}.swico-${process.pid}-${Date.now()}.tmp`
    await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, target)
    return { path, sha256: createHash('sha256').update(content).digest('hex') }
  }
  async runCommand(argv: string[], timeoutMs: number, approve: () => Promise<boolean>): Promise<{ code: number | null; stdout: string; stderr: string; timed_out: boolean }> {
    if (!argv.length || argv.length > 32 || argv.some(value => value.length > 512)) throw new Error('Command arguments are outside the bounded policy.')
    if (!await approve()) throw new Error('Command was not approved.')
    return new Promise((resolveResult, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: this.root, shell: false, detached: process.platform !== 'win32', env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8' } })
      let stdout = '', stderr = ''; const cap = 128 * 1024
      let timedOut = false
      child.stdout.on('data', chunk => { stdout = (stdout + cleanTerminal(String(chunk))).slice(0, cap) })
      child.stderr.on('data', chunk => { stderr = (stderr + cleanTerminal(String(chunk))).slice(0, cap) })
      const timer = setTimeout(() => {
        timedOut = true
        if (process.platform === 'win32') child.kill()
        else if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { /* it may have exited */ } }
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL') }, 500)
      }, Math.max(100, Math.min(timeoutMs, 120_000)))
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolveResult({ code, stdout, stderr, timed_out: timedOut }) })
    })
  }
}
