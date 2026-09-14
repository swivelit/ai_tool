import { execFile } from 'node:child_process'
import { realpath, lstat, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, relative, resolve } from 'node:path'

const exec = promisify(execFile)
const MAX_INSTRUCTIONS = 32 * 1024
const MAX_GIT_OUTPUT = 128 * 1024

export type RepositoryMetadata = {
  root: string
  branch: string | null
  head: string | null
  dirty: boolean | null
  staged: string[]
  unstaged: string[]
  untracked: string[]
  gitAvailable: boolean
}

export type RepositoryInstructions = {
  files: string[]
  text: string
  truncated: boolean
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await exec('git', args, { cwd, windowsHide: true, maxBuffer: MAX_GIT_OUTPUT })
  return result.stdout.trim()
}

function lines(value: string): string[] { return value ? value.split(/\r?\n/).filter(Boolean) : [] }

export async function discoverRepository(start = process.cwd()): Promise<RepositoryMetadata> {
  const cwd = await realpath(resolve(start))
  try {
    const root = await realpath(await git(['rev-parse', '--show-toplevel'], cwd))
    const status = await git(['status', '--porcelain=v1'], root)
    const staged: string[] = [], unstaged: string[] = [], untracked: string[] = []
    for (const line of lines(status)) {
      const code = line.slice(0, 2), path = line.slice(3)
      if (code === '??') untracked.push(path)
      else {
        if (code[0] !== ' ') staged.push(path)
        if (code[1] !== ' ') unstaged.push(path)
      }
    }
    return {
      root, branch: await git(['symbolic-ref', '--short', '-q', 'HEAD'], root).catch(() => null),
      head: await git(['rev-parse', '--verify', 'HEAD'], root).catch(() => null),
      dirty: Boolean(status), staged, unstaged, untracked, gitAvailable: true,
    }
  } catch {
    return { root: cwd, branch: null, head: null, dirty: null, staged: [], unstaged: [], untracked: [], gitAvailable: false }
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate).replaceAll('\\', '/')
  return rel === '' || (!rel.startsWith('..') && !rel.includes('/..') && !rel.includes('\\..'))
}

export async function loadRepositoryInstructions(metadata: RepositoryMetadata, cwd = process.cwd()): Promise<RepositoryInstructions> {
  const current = await realpath(resolve(cwd))
  if (!inside(metadata.root, current)) return { files: [], text: '', truncated: false }
  const directories: string[] = []
  for (let directory = current; inside(metadata.root, directory); directory = dirname(directory)) {
    directories.push(directory)
    if (directory === metadata.root) break
  }
  directories.reverse()
  const files: string[] = [], chunks: string[] = []
  let used = 0, truncated = false
  for (const directory of directories) {
    const filename = resolve(directory, 'AGENTS.md')
    try {
      const stat = await lstat(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const real = await realpath(filename)
      if (!inside(metadata.root, real)) continue
      const remaining = MAX_INSTRUCTIONS - used
      if (remaining <= 0) { truncated = true; break }
      const fullContent = await readFile(real, 'utf8')
      const content = fullContent.slice(0, remaining)
      chunks.push(`\n# Instructions from ${relative(metadata.root, real) || 'AGENTS.md'}\n${content}`)
      files.push(relative(metadata.root, real) || 'AGENTS.md')
      used += content.length
      if (content.length < fullContent.length) { truncated = true; break }
    } catch { /* absent or unreadable instructions are not fatal */ }
  }
  return { files, text: chunks.join(''), truncated }
}
