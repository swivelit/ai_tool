import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateCanonicalArtifact } from '../scripts/validate-canonical-artifact.mjs'

const version = '0.2.1'
const revision = '90516e1a7625b14e2807d1893dc134357f72a8af'
const tarball = `swiveltechnologies-swico-${version}.tgz`
const workspaces = []

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'swico-canonical-test-'))
  workspaces.push(directory)
  const bytes = Buffer.from('canonical tarball fixture')
  await writeFile(join(directory, tarball), bytes)
  await writeFile(join(directory, 'swico-release-manifest.json'), JSON.stringify({
    package:'@swiveltechnologies/swico', version, git_revision:revision, dirty:false,
    artifact_filename:tarball, sha256:createHash('sha256').update(bytes).digest('hex'),
  }))
  return directory
}

afterEach(async () => Promise.all(workspaces.splice(0).map(directory => rm(directory, { recursive:true, force:true }))))

describe('canonical release artifact validation', () => {
  it('accepts the exact flat two-file artifact', async () => {
    const directory = await fixture()
    await assert.doesNotReject(validateCanonicalArtifact(directory, { version, revision }))
  })

  it('rejects an extra artifact file', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'unexpected.log'), 'no')
    await assert.rejects(validateCanonicalArtifact(directory, { version, revision }), /exactly/)
  })

  it('rejects a manifest SHA mismatch', async () => {
    const directory = await fixture()
    const manifestPath = join(directory, 'swico-release-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.sha256 = '0'.repeat(64)
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(validateCanonicalArtifact(directory, { version, revision }), /SHA-256/)
  })

  it('rejects a manifest source revision mismatch', async () => {
    const directory = await fixture()
    const manifestPath = join(directory, 'swico-release-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.git_revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(validateCanonicalArtifact(directory, { version, revision }), /git_revision/)
  })
})
