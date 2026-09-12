import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
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

test('search uses the same protected-file policy as reads and safely handles regex/options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-cli-search-security-'))
  const previousPath = process.env.PATH
  try {
    await mkdir(join(root, 'secrets'), { recursive: true })
    await writeFile(join(root, 'secrets', 'fixture.txt'), 'FAKE_SECRET_MARKER')
    await writeFile(join(root, 'code.txt'), 'value 42\n-looks-like-an-option\n')
    const workspace = new Workspace(root)
    await assert.rejects(() => workspace.readFile('secrets/fixture.txt'), /safe workspace/)
    assert.deepEqual(await workspace.searchText('FAKE_SECRET_MARKER'), [])
    assert.equal((await workspace.searchText('value [0-9]+', 10, { regex: true })).length, 1)
    assert.equal((await workspace.searchText('-looks-like-an-option')).length, 1)
    process.env.PATH = ''
    assert.equal((await workspace.searchText('value [0-9]+', 10, { regex: true })).length, 1)
    await assert.rejects(() => workspace.searchText('[', 10, { regex: true }), /invalid/)
  } finally { process.env.PATH = previousPath; }
})

test('read-only sandbox policy is a hard mutation boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-cli-read-only-'))
  try {
    await writeFile(join(root, 'existing.txt'), 'original\n')
    const workspace = new Workspace(root, undefined, 'read-only')
    await assert.rejects(() => workspace.createFile('new.txt', 'nope', async () => true), /read-only sandbox policy/)
    await assert.rejects(() => workspace.deleteFile('existing.txt', async () => true), /read-only sandbox policy/)
    await assert.rejects(() => workspace.moveFile('existing.txt', 'moved.txt', async () => true), /read-only sandbox policy/)
  } finally { }
})

test('unified patches validate context and leave the file unchanged on mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-cli-patch-security-'))
  try {
    await writeFile(join(root, 'file.txt'), 'one\ntwo\nthree\n')
    const workspace = new Workspace(root), original = await workspace.readFile('file.txt')
    await assert.rejects(() => workspace.applyPatch('file.txt', original.sha256, '@@ -1,2 +1,1 @@\n-one\n-wrong\n+changed\n', async () => true), /context does not match/)
    assert.equal((await workspace.readFile('file.txt')).text, 'one\ntwo\nthree\n')
    const changed = await workspace.applyPatch('file.txt', original.sha256, '@@ -1,3 +1,2 @@\n-one\n-two\n+changed\n three\n', async () => true)
    assert.equal(changed.path, 'file.txt')
    assert.equal((await workspace.readFile('file.txt')).text, 'changed\nthree\n')
  } finally { }
})

test('createFile cannot clobber a file created while approval is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-cli-create-race-'))
  try {
    const workspace = new Workspace(root), approval = async () => { await writeFile(join(root, 'race.txt'), 'user-created\n'); return true }
    await assert.rejects(() => workspace.createFile('race.txt', 'agent-created\n', approval), /created while approval was pending/)
    assert.equal(await readFile(join(root, 'race.txt'), 'utf8'), 'user-created\n')
  } finally { }
})

test('command cancellation escalates when a child ignores termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-cli-command-kill-'))
  try {
    const workspace = new Workspace(root)
    const result = await workspace.runCommand([process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], 100, async () => true)
    assert.equal(result.timed_out, true)
    assert.ok(result.elapsed_ms < 4_000)
  } finally { }
})
