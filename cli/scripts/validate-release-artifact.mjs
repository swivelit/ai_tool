/* CI-only artifact validator. It is excluded from the customer package. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const archivePath = resolve(process.argv[2] ?? '')
const manifestPath = resolve(process.argv[3] ?? 'release-artifact-manifest.json')
const cliRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceManifest = JSON.parse(await readFile(resolve(cliRoot, 'package.json'), 'utf8'))

const requiredEntries = [
  'package/package.json', 'package/README.md', 'package/LICENSE', 'package/LICENSE_SCOPE.md', 'package/THIRD_PARTY_NOTICES.md',
  'package/dist/agent.js', 'package/dist/api.js', 'package/dist/arguments.js', 'package/dist/build_identity.js', 'package/dist/cli.js',
  'package/dist/cloud.js', 'package/dist/command_registry.js', 'package/dist/completion.js', 'package/dist/config.js', 'package/dist/configuration.js',
  'package/dist/context.js', 'package/dist/contracts.js', 'package/dist/credentials.js', 'package/dist/hooks.js', 'package/dist/journal.js',
  'package/dist/local_sessions.js', 'package/dist/mcp.js', 'package/dist/mcp_server.js', 'package/dist/output_schema.js', 'package/dist/permissions.js',
  'package/dist/plan.js', 'package/dist/plugins.js', 'package/dist/release_readiness.js', 'package/dist/repository.js', 'package/dist/sandbox.js',
  'package/dist/session.js', 'package/dist/skills.js', 'package/dist/sse.js', 'package/dist/subagents.js', 'package/dist/terminal_output.js',
  'package/dist/terminal_ui.js', 'package/dist/usage.js', 'package/dist/workspace.js', 'package/dist/worktrees.js',
]

function archiveEntries(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buffer.length) throw new Error(`invalid tar entry: ${fullName}`)
    entries.set(fullName, buffer.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function git(args) {
  return execFileSync('git', args, { cwd: resolve(cliRoot, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

if (basename(archivePath) !== `swiveltechnologies-swico-${sourceManifest.version}.tgz`) throw new Error(`unexpected artifact filename: ${basename(archivePath)}`)
const archive = await readFile(archivePath)
const entries = archiveEntries(gunzipSync(archive))
const actualEntries = [...entries.keys()].sort()
const expectedEntries = [...requiredEntries].sort()
if (actualEntries.length !== expectedEntries.length || actualEntries.some((entry, index) => entry !== expectedEntries[index])) {
  throw new Error(`package contents differ from the approved allowlist: ${actualEntries.filter(entry => !expectedEntries.includes(entry)).join(', ')}`)
}
for (const entry of actualEntries) {
  if (entry.includes('node_modules/') || entry.startsWith('package/test/') || entry.startsWith('package/src/') || entry.endsWith('.ts') || entry.endsWith('.map') || /(^|\/)(?:\.env[^/]*|\.npmrc|credentials(?:\.(?:json|toml|ya?ml)|$)|secrets(?:\.(?:json|toml|ya?ml)|\/)|action-journal)/i.test(entry)) throw new Error(`forbidden package entry: ${entry}`)
}

const packedManifest = JSON.parse(entries.get('package/package.json').toString('utf8'))
if (packedManifest.name !== '@swiveltechnologies/swico' || packedManifest.version !== sourceManifest.version || packedManifest.license !== 'MIT' || packedManifest.bin?.swico !== 'dist/cli.js') throw new Error('packed package identity or license is invalid')
const buildIdentityText = entries.get('package/dist/build_identity.js').toString('utf8')
const identityMatch = buildIdentityText.match(/Object\.freeze\((\{.*\})\)/s)
if (!identityMatch) throw new Error('embedded build identity is missing')
const embedded = JSON.parse(identityMatch[1])
const revision = git(['rev-parse', 'HEAD'])
const dirty = Boolean(git(['status', '--porcelain', '--untracked-files=all']))
if (!revision || revision === 'unknown' || dirty || embedded.revision !== revision || embedded.dirty !== false) throw new Error(`clean build identity mismatch: embedded=${JSON.stringify(embedded)} checkout=${JSON.stringify({ revision, dirty })}`)

const releaseManifest = {
  package: packedManifest.name,
  version: packedManifest.version,
  git_revision: revision,
  dirty,
  sha256: createHash('sha256').update(archive).digest('hex'),
  node: process.version,
  workflow: Object.fromEntries(Object.entries({
    run_id: process.env.GITHUB_RUN_ID,
    run_number: process.env.GITHUB_RUN_NUMBER,
    workflow: process.env.GITHUB_WORKFLOW,
    ref: process.env.GITHUB_REF,
  }).filter(([, value]) => value)),
  artifact_filename: basename(archivePath),
}
await writeFile(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`)
console.log(JSON.stringify(releaseManifest, null, 2))
