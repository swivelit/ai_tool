import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../dist/workspace.js'
import { discoverRepository, loadRepositoryInstructions } from '../dist/repository.js'

test('repository discovery loads root-to-nearest AGENTS instructions with a bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-repo-'))
  await mkdir(join(root, 'src', 'nested'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), 'root rule')
  await writeFile(join(root, 'src', 'AGENTS.md'), 'near rule')
  const metadata = await discoverRepository(root)
  assert.equal(metadata.gitAvailable, false)
  const instructions = await loadRepositoryInstructions(metadata, join(root, 'src', 'nested'))
  assert.deepEqual(instructions.files, ['AGENTS.md', 'src/AGENTS.md'])
  assert.match(instructions.text, /root rule/) ; assert.match(instructions.text, /near rule/)
})

test('search uses bounded line-aware results and patch hunks preserve unrelated lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-search-'))
  await writeFile(join(root, 'a.ts'), 'first\nneedle here\nlast\n')
  await writeFile(join(root, '.env.production'), 'needle=secret\n')
  const workspace = new Workspace(root)
  const hits = await workspace.searchText('needle')
  assert.equal(hits.length, 1); assert.match(hits[0], /(?:\.\/)?a\.ts:2:/)
  await assert.rejects(() => workspace.readFile('.env.production'), /safe workspace/)
  const original = await workspace.readFile('a.ts')
  const changed = await workspace.applyPatch('a.ts', original.sha256, '@@ -2,1 +2,1 @@\n-needle here\n+needle changed', async () => true)
  assert.equal(changed.path, 'a.ts'); assert.equal((await workspace.readFile('a.ts')).text, 'first\nneedle changed\nlast\n')
})

test('workspace rejects symlink escapes and protects mutating operations with approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swico-confine-')), outside = await mkdtemp(join(tmpdir(), 'swico-outside-'))
  await writeFile(join(outside, 'secret.txt'), 'outside')
  await symlink(outside, join(root, 'linked'))
  const workspace = new Workspace(root)
  await assert.rejects(() => workspace.readFile('linked/secret.txt'), /workspace|Symlink/)
  await assert.rejects(() => workspace.createFile('new.txt', 'x', async () => false), /not approved/)
  await workspace.createFile('new.txt', 'x', async () => true)
  await assert.rejects(() => workspace.deleteFile('new.txt', async () => false), /not approved/)
})
