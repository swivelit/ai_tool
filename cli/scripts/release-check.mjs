import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const keepArtifact = process.argv.includes('--keep-artifact')

function archiveEntries(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix ? `${prefix}/${name}` : name
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = Number.parseInt(sizeText || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buffer.length) throw new Error(`Invalid tar entry: ${fullName}`)
    entries.set(fullName, buffer.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

async function run(command, args, options = {}) {
  return exec(command, args, {
    cwd: root,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: join(work, 'npm-cache') },
    ...options,
  })
}

const work = await mkdtemp(join(tmpdir(), 'swico-release-'))
try {
  const packed = await run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', work])
  const records = JSON.parse(packed.stdout)
  const record = Array.isArray(records) ? records[0] : records
  if (!record?.filename) throw new Error('npm pack did not return an artifact filename')
  const archivePath = join(work, record.filename)
  const archive = await readFile(archivePath)
  const entries = archiveEntries(gunzipSync(archive))
  const manifestBytes = entries.get('package/package.json')
  if (!manifestBytes) throw new Error('Package archive has no package.json')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.name !== '@swiveltechnologies/swico') throw new Error(`Unexpected package name: ${manifest.name}`)
  if (manifest.bin?.swico !== 'dist/cli.js') throw new Error('The swico executable does not map to dist/cli.js')
  const required = [
    'package/package.json', 'package/README.md',
    'package/dist/cli.js', 'package/dist/api.js', 'package/dist/config.js',
    'package/dist/agent.js', 'package/dist/contracts.js', 'package/dist/context.js',
    'package/dist/credentials.js', 'package/dist/journal.js', 'package/dist/local_sessions.js',
    'package/dist/permissions.js', 'package/dist/plan.js', 'package/dist/repository.js',
    'package/dist/session.js', 'package/dist/sse.js', 'package/dist/workspace.js',
  ]
  for (const entry of required) if (!entries.has(entry)) throw new Error(`Missing required release file: ${entry}`)
  for (const entry of entries.keys()) {
    if (entry.startsWith('package/src/') || entry.startsWith('package/test/') || entry.startsWith('package/node_modules/') || entry.startsWith('package/bin/') || entry.endsWith('.map') || /(^|\/)(?:\.env[^/]*|\.npmrc|\.pypirc|\.swico|credentials\.json|action-journal)/i.test(entry)) {
      throw new Error(`Unwanted file in release archive: ${entry}`)
    }
  }

  const prefix = join(work, 'prefix')
  await run(npm, ['install', '--global', '--prefix', prefix, '--ignore-scripts', archivePath])
  const executable = process.platform === 'win32' ? join(prefix, 'swico.cmd') : join(prefix, 'bin', 'swico')
  const help = await exec(executable, ['--help'], { cwd: work, maxBuffer: 512 * 1024 })
  const version = await exec(executable, ['--version'], { cwd: work, maxBuffer: 512 * 1024 })
  const doctor = await exec(executable, ['doctor'], { cwd: work, env: { ...process.env, SWICO_CLI_DOCTOR_OFFLINE: '1' }, maxBuffer: 512 * 1024 })
  if (!help.stdout.includes('Usage: swico')) throw new Error('Installed --help output is invalid')
  if (version.stdout.trim() !== manifest.version) throw new Error(`Installed version mismatch: ${version.stdout.trim()}`)
  const digest = createHash('sha256').update(archive).digest('hex')
  if (keepArtifact) await copyFile(archivePath, join(root, record.filename))
  console.log(JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    filename: record.filename,
    sha256: digest,
    archive_files: [...entries.keys()].sort(),
    installed_checks: { help: 'passed', version: 'passed', doctor: 'passed (offline)' },
    retained_artifact: keepArtifact ? join(root, record.filename) : null,
    doctor_output: JSON.parse(doctor.stdout),
  }, null, 2))
} finally {
  await rm(work, { recursive: true, force: true })
}
