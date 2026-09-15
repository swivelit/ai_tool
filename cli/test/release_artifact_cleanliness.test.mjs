import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const validatorPath = resolve(repoRoot, 'cli/scripts/validate-release-artifact.mjs')
const fixtures = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function status(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=all'])
}

async function cleanGitFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'swico-release-cleanliness-'))
  fixtures.push(directory)
  git(directory, ['init', '-q'])
  await writeFile(join(directory, 'tracked.txt'), 'initial\n')
  git(directory, ['add', 'tracked.txt'])
  git(directory, [
    '-c', 'user.name=Swico test',
    '-c', 'user.email=swico-test@example.invalid',
    'commit', '-qm', 'initial',
  ])
  return directory
}

afterEach(async () => Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive:true, force:true }))))

describe('release artifact checkout cleanliness', () => {
  it('preserves the validator’s strict revision and dirty-state contract', async () => {
    const source = await readFile(validatorPath, 'utf8')
    assert.match(source, /git\(\['rev-parse', 'HEAD'\]\)/)
    assert.match(source, /git\(\['status', '--porcelain', '--untracked-files=all'\]\)/)
    assert.match(source, /if \(!revision.*dirty.*embedded\.revision !== revision.*embedded\.dirty !== false\)/)
  })

  it('accepts a clean checkout and keeps an external artifact directory invisible to Git', async () => {
    const checkout = await cleanGitFixture()
    const artifact = await mkdtemp(join(tmpdir(), 'swico-release-artifact-'))
    fixtures.push(artifact)
    await writeFile(join(artifact, 'swiveltechnologies-swico-0.2.1.tgz'), 'tarball')
    await writeFile(join(artifact, 'swico-release-manifest.json'), '{}')

    assert.equal(status(checkout), '')
  })

  it('detects tracked modifications and untracked files', async () => {
    const trackedChange = await cleanGitFixture()
    await writeFile(join(trackedChange, 'tracked.txt'), 'modified\n')
    assert.match(status(trackedChange), /^M tracked\.txt/)

    const untrackedChange = await cleanGitFixture()
    await writeFile(join(untrackedChange, 'untracked.txt'), 'untracked\n')
    assert.match(status(untrackedChange), /\?\? untracked\.txt/)
  })
})
