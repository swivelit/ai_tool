import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateInstalledLauncher } from '../scripts/accept-installed-agent.mjs'

async function fixtureLauncher(expectedVersion = '0.2.8') {
  const root = await mkdtemp(join(tmpdir(), 'swico-launcher-preflight-'))
  const prefix = join(root, 'prefix')
  const bin = join(prefix, 'bin')
  const target = join(prefix, 'lib', 'swico.js')
  await mkdir(bin, { recursive: true })
  await mkdir(join(prefix, 'lib'), { recursive: true })
  await writeFile(target, `#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log(${JSON.stringify(expectedVersion)})\nelse if (process.argv[2] === '--help') console.log('Usage: swico [command]')\n`)
  await chmod(target, 0o755)
  const launcher = join(bin, 'swico')
  await symlink('../lib/swico.js', launcher)
  return { root, prefix, launcher, target }
}

test('installed launcher preflight rejects a missing launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-launcher-missing-'))
  try { await assert.rejects(() => validateInstalledLauncher({ launcher: join(root, 'bin', 'swico'), prefix: root, expectedVersion: '0.2.8' }), /installed launcher missing/) } finally { await rm(root, { recursive: true, force: true }) }
})

test('installed launcher preflight rejects a wrong version', async () => {
  const fixture = await fixtureLauncher('0.0.0')
  try { await assert.rejects(() => validateInstalledLauncher({ launcher: fixture.launcher, prefix: fixture.prefix, expectedVersion: '0.2.8' }), /version mismatch/) } finally { await rm(fixture.root, { recursive: true, force: true }) }
})

test('installed launcher preflight rejects a non-executable target', { skip: process.platform === 'win32' }, async () => {
  const fixture = await fixtureLauncher()
  try {
    await chmod(fixture.target, 0o644)
    await assert.rejects(() => validateInstalledLauncher({ launcher: fixture.launcher, prefix: fixture.prefix, expectedVersion: '0.2.8' }), /not executable/)
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
})

test('installed launcher preflight rejects a broken symlink', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-launcher-broken-'))
  const prefix = join(root, 'prefix'), bin = join(prefix, 'bin')
  try {
    await mkdir(bin, { recursive: true })
    await symlink('../lib/missing.js', join(bin, 'swico'))
    await assert.rejects(() => validateInstalledLauncher({ launcher: join(bin, 'swico'), prefix, expectedVersion: '0.2.8' }), /broken symlink/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
