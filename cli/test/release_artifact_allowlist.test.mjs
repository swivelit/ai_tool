import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { RELEASE_PACKAGE_ENTRIES } from '../scripts/release-artifact-allowlist.mjs'

const cliRoot = fileURLToPath(new URL('../', import.meta.url))
const fixtures = []
const additions = ['clipboard', 'multi_agent', 'prompt_history'].map(name => `package/dist/${name}.js`)

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// Build a real ustar-format fixture using only Node built-ins. These tests run
// before (and independently of) installing the application's dependencies.
function tarGzip(entries) {
  const parts = []
  for (const [name, value] of entries) {
    const data = Buffer.from(value)
    assert.ok(Buffer.byteLength(name) < 100, 'fixture names must fit in a ustar header')
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header.fill(32, 148, 156)
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'swico-allowlist-'))
  fixtures.push(base)
  const checkout = join(base, 'checkout')
  const scripts = join(checkout, 'cli', 'scripts')
  const output = join(base, 'output')
  await mkdir(scripts, { recursive: true })
  await mkdir(output)
  const manifest = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'))
  await writeFile(join(checkout, 'cli', 'package.json'), JSON.stringify(manifest) + '\n')
  for (const script of ['validate-release-artifact.mjs', 'release-artifact-allowlist.mjs']) {
    await copyFile(join(cliRoot, 'scripts', script), join(scripts, script))
  }
  git(checkout, ['init', '-q'])
  git(checkout, ['add', '.'])
  git(checkout, ['-c', 'user.name=Swico test', '-c', 'user.email=swico-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'])
  const revision = git(checkout, ['rev-parse', 'HEAD'])
  const entries = new Map(RELEASE_PACKAGE_ENTRIES.map(name => [name, '// reviewed fixture content\n']))
  entries.set('package/package.json', JSON.stringify(manifest))
  entries.set('package/dist/build_identity.js', `export const BUILD_IDENTITY = Object.freeze(${JSON.stringify({ revision, dirty: false })})\n`)
  return {
    checkout, revision, entries, manifest,
    validator: join(scripts, 'validate-release-artifact.mjs'),
    archive: join(output, `swiveltechnologies-swico-${manifest.version}.tgz`),
    outputManifest: join(output, 'release-manifest.json'),
  }
}

async function validate(value, archivePath = value.archive) {
  await writeFile(archivePath, tarGzip(value.entries))
  return spawnSync(process.execPath, [value.validator, archivePath, value.outputManifest], {
    cwd: value.checkout, encoding: 'utf8', timeout: 15_000,
  })
}

function rejected(result, pattern) {
  assert.equal(result.status, 1, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, pattern)
}

afterEach(async () => Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('reviewed release package allowlist', () => {
  it('is explicit, frozen, unique, and matches current production source modules', async () => {
    const sourceOutputs = []
    async function visit(directory, prefix = '') {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const relative = `${prefix}${item.name}`
        if (item.isDirectory()) await visit(join(directory, item.name), `${relative}/`)
        else if (item.isFile() && item.name.endsWith('.ts') && !item.name.endsWith('.d.ts')) {
          sourceOutputs.push(`package/dist/${relative.replace(/\.ts$/, '.js')}`)
        }
      }
    }
    await visit(join(cliRoot, 'src'))
    assert.equal(Object.isFrozen(RELEASE_PACKAGE_ENTRIES), true)
    assert.equal(new Set(RELEASE_PACKAGE_ENTRIES).size, RELEASE_PACKAGE_ENTRIES.length)
    assert.deepEqual([...RELEASE_PACKAGE_ENTRIES].sort(), [
      ...sourceOutputs,
      'package/package.json', 'package/README.md', 'package/LICENSE',
      'package/LICENSE_SCOPE.md', 'package/THIRD_PARTY_NOTICES.md',
    ].sort(), 'Review runtime file changes and update the explicit allowlist; never approve the archive automatically.')
    for (const name of additions) assert.ok(RELEASE_PACKAGE_ENTRIES.includes(name), `missing reviewed module: ${name}`)
  })

  it('accepts all reviewed files with clean matching identity and emits the archive hash', async () => {
    const value = await fixture()
    const result = await validate(value)
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`)
    const output = JSON.parse(await readFile(value.outputManifest, 'utf8'))
    assert.equal(output.git_revision, value.revision)
    assert.equal(output.dirty, false)
    assert.equal(output.version, value.manifest.version)
    assert.equal(output.sha256, createHash('sha256').update(await readFile(value.archive)).digest('hex'))
    assert.equal(git(value.checkout, ['status', '--porcelain', '--untracked-files=all']), '')
  })

  for (const name of additions) {
    it(`rejects a missing runtime file: ${name}`, async () => {
      const value = await fixture()
      value.entries.delete(name)
      const result = await validate(value)
      rejected(result, /package contents differ from the approved allowlist/)
      assert.ok(result.stderr.includes(`missing=[${name}]`), result.stderr)
    })
  }

  for (const name of [
    'package/dist/unreviewed.js', 'package/.env.production',
    'package/src/private.ts', 'package/test/fixture.mjs',
    'package/dist/cli.js.map', 'package/node_modules/private/index.js',
  ]) {
    it(`rejects an unexpected archive member: ${name}`, async () => {
      const value = await fixture()
      value.entries.set(name, 'not approved\n')
      const result = await validate(value)
      rejected(result, /package contents differ from the approved allowlist/)
      assert.ok(result.stderr.includes(`unexpected=[${name}]`), result.stderr)
    })
  }

  it('reports both missing and unexpected members even when counts match', async () => {
    const value = await fixture()
    value.entries.delete(additions[0])
    value.entries.set('package/dist/unreviewed.js', '// not approved\n')
    const result = await validate(value)
    rejected(result, /unexpected=\[package\/dist\/unreviewed.js\]; missing=\[package\/dist\/clipboard.js\]/)
  })

  it('preserves rejection of dirty tracked and untracked checkout files', async () => {
    const value = await fixture()
    await writeFile(join(value.checkout, 'cli', 'package.json'), JSON.stringify(value.manifest) + '\n\n')
    rejected(await validate(value), /clean build identity mismatch/)
    git(value.checkout, ['checkout', '--', 'cli/package.json'])
    await writeFile(join(value.checkout, 'unexpected.txt'), 'untracked\n')
    rejected(await validate(value), /clean build identity mismatch/)
  })

  it('preserves rejection of stale or dirty embedded build identity', async () => {
    const value = await fixture()
    for (const identity of [{ revision: '0'.repeat(40), dirty: false }, { revision: value.revision, dirty: true }]) {
      value.entries.set('package/dist/build_identity.js', `export const BUILD_IDENTITY = Object.freeze(${JSON.stringify(identity)})\n`)
      rejected(await validate(value), /clean build identity mismatch/)
    }
  })

  it('preserves package identity, license, executable and filename checks', async () => {
    const value = await fixture()
    for (const changes of [{ name: '@other/swico' }, { version: '0.0.0-test' }, { license: 'UNLICENSED' }, { bin: { swico: 'wrong.js' } }]) {
      value.entries.set('package/package.json', JSON.stringify({ ...value.manifest, ...changes }))
      rejected(await validate(value), /packed package identity or license is invalid/)
    }
    value.entries.set('package/package.json', JSON.stringify(value.manifest))
    rejected(await validate(value, join(value.archive, '..', 'wrong-name.tgz')), /unexpected artifact filename/)
  })
})
