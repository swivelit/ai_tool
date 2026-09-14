import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

function git(args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return '' }
}

const revision = git(['rev-parse', '--verify', 'HEAD']) || 'unknown'
const status = git(['status', '--porcelain', '--untracked-files=all'])
const dirty = revision === 'unknown' ? 'unknown' : Boolean(status)

execFileSync(process.execPath, [join(cliRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(cliRoot, 'tsconfig.json')], { cwd: cliRoot, stdio: 'inherit' })
await mkdir(join(cliRoot, 'dist'), { recursive: true })
await writeFile(join(cliRoot, 'dist', 'build_identity.js'), `export const BUILD_IDENTITY = Object.freeze(${JSON.stringify({ revision, dirty })})\n`)
