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
const STAGE_TIMEOUT_MS = 90_000

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

async function run(label, command, args, options = {}) {
  process.stderr.write(`[release-check] ${label}\n`)
  try {
    return await exec(command, args, {
      cwd: root,
      maxBuffer: 2 * 1024 * 1024,
      timeout: STAGE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      env: { ...process.env, npm_config_cache: join(work, 'npm-cache') },
      ...options,
    })
  } catch (error) {
    const detail = [error?.timedOut ? 'timed out' : '', error?.killed ? 'process killed' : '', error?.stderr, error?.stdout, error?.code ? `code=${error.code}` : '']
      .filter(Boolean).join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1_000)
    throw new Error(`${label} failed: ${detail || 'unknown subprocess failure'}`)
  }
}

const work = await mkdtemp(join(tmpdir(), 'swico-release-'))
try {
  const packed = await run('pack', npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', work])
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
    'package/dist/output_schema.js',
    'package/dist/session.js', 'package/dist/sse.js', 'package/dist/workspace.js',
    'package/dist/completion.js', 'package/dist/configuration.js', 'package/dist/hooks.js',
    'package/dist/mcp.js', 'package/dist/mcp_server.js', 'package/dist/plugins.js',
    'package/dist/skills.js', 'package/dist/subagents.js', 'package/dist/sandbox.js',
    'package/dist/worktrees.js', 'package/dist/cloud.js', 'package/dist/release_readiness.js',
  ]
  for (const entry of required) if (!entries.has(entry)) throw new Error(`Missing required release file: ${entry}`)
  for (const entry of entries.keys()) {
    if (entry.startsWith('package/src/') || entry.startsWith('package/test/') || entry.startsWith('package/node_modules/') || entry.startsWith('package/bin/') || entry.endsWith('.map') || /(^|\/)(?:\.env[^/]*|\.npmrc|\.pypirc|\.swico|credentials\.json|action-journal)/i.test(entry)) {
      throw new Error(`Unwanted file in release archive: ${entry}`)
    }
  }

  const prefix = join(work, 'prefix')
  await run('clean-prefix install', npm, ['install', '--global', '--prefix', prefix, '--ignore-scripts', archivePath])
  const executable = process.platform === 'win32' ? join(prefix, 'swico.cmd') : join(prefix, 'bin', 'swico')
  // Artifact smoke tests must never inspect the operator's real keychain,
  // config, state, or sessions. Use an isolated empty state rooted in the
  // temporary release directory.
  const isolatedEnv = {
    ...process.env,
    SWICO_CLI_CREDENTIAL_FILE: join(work, 'empty-credentials.json'),
    SWICO_CLI_STATE_DIR: join(work, 'state'),
    SWICO_CLI_CONFIG_FILE: join(work, 'config.toml'),
    XDG_CONFIG_HOME: join(work, 'xdg'),
  }
  const smokeOptions = { cwd: work, maxBuffer: 512 * 1024, env: isolatedEnv }
  const help = await run('installed --help', executable, ['--help'], smokeOptions)
  const version = await run('installed --version', executable, ['--version'], smokeOptions)
  const doctor = await run('installed offline doctor', executable, ['doctor'], { ...smokeOptions, env: { ...isolatedEnv, SWICO_CLI_DOCTOR_OFFLINE: '1' } })
  const config = await run('installed config validate', executable, ['config', 'validate'], smokeOptions)
  const completion = await run('installed completion', executable, ['completion', 'bash'], smokeOptions)
  const sandbox = await run('installed sandbox status', executable, ['sandbox', 'status'], smokeOptions)
  if (!help.stdout.includes('Usage: swico')) throw new Error('Installed --help output is invalid')
  if (version.stdout.trim() !== manifest.version) throw new Error(`Installed version mismatch: ${version.stdout.trim()}`)
  if (!config.stdout.includes('Configuration is valid')) throw new Error('Installed config validation output is invalid')
  if (!completion.stdout.includes('swico')) throw new Error('Installed completion output is invalid')
  if (!sandbox.stdout.includes('"diagnostic"')) throw new Error('Installed sandbox status output is invalid')
  const digest = createHash('sha256').update(archive).digest('hex')
  if (keepArtifact) await copyFile(archivePath, join(root, record.filename))
  console.log(JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    filename: record.filename,
    sha256: digest,
    archive_files: [...entries.keys()].sort(),
    installed_checks: { help: 'passed', version: 'passed', doctor: 'passed (offline)', config_validate: 'passed', completion: 'passed', sandbox_status: 'passed (readiness only)' },
    retained_artifact: keepArtifact ? join(root, record.filename) : null,
    doctor_output: JSON.parse(doctor.stdout),
  }, null, 2))
} finally {
  await rm(work, { recursive: true, force: true })
}
