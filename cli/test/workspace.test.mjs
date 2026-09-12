import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../dist/workspace.js'

test('workspace tools confine reads and apply an approved hash-checked atomic edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-cli-'))
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'a.txt'), 'old')
  const workspace = new Workspace(root); const original = await workspace.readFile('src/a.txt')
  await assert.rejects(() => workspace.readFile('../outside.txt'))
  let approval = ''
  const changed = await workspace.applyPatch('src/a.txt', original.sha256, 'new', async description => { approval = description; return true })
  assert.equal(changed.path, 'src/a.txt'); assert.equal((await workspace.readFile('src/a.txt')).text, 'new')
  assert.match(approval, /--- current src\/a\.txt[\s\S]*- old[\s\S]*\+ new/)
  await assert.rejects(() => workspace.applyPatch('src/a.txt', original.sha256, 'bad', async () => true))
})

test('commands require explicit approval and do not use a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-cli-command-')); const workspace = new Workspace(root)
  await assert.rejects(() => workspace.runCommand(['node', '-e', 'process.stdout.write("x")'], 1000, async () => false))
  const result = await workspace.runCommand(['node', '-e', 'process.stdout.write("x\\u001b[31m")'], 1000, async () => true)
  assert.equal(result.code, 0); assert.equal(result.stdout, 'x')
  const timedOut = await workspace.runCommand(['node', '-e', 'setTimeout(() => {}, 5000)'], 100, async () => true)
  assert.equal(timedOut.timed_out, true)
  const controller = new AbortController()
  const cancelled = workspace.runCommand(['node', '-e', 'setTimeout(() => {}, 5000)'], 5000, async () => true, controller.signal)
  controller.abort()
  assert.equal((await cancelled).cancelled, true)
})
