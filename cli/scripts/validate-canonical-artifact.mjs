import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function validateCanonicalArtifact(directory, { packageName = '@swiveltechnologies/swico', version, revision } = {}) {
  const root = resolve(directory)
  const expectedTarball = `swiveltechnologies-swico-${version}.tgz`
  const expected = [expectedTarball, 'swico-release-manifest.json'].sort()
  const entries = (await readdir(root, { withFileTypes:true })).map(entry => entry.name).sort()
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
    throw new Error(`canonical artifact must contain exactly ${expected.join(' and ')}; found ${entries.join(', ')}`)
  }
  const tarballPath = join(root, expectedTarball)
  const manifestPath = join(root, 'swico-release-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const identity = { package:packageName, version, git_revision:revision, dirty:false, artifact_filename:expectedTarball }
  for (const [key, value] of Object.entries(identity)) if (manifest[key] !== value) throw new Error(`manifest ${key} mismatch`)
  const sha256 = createHash('sha256').update(await readFile(tarballPath)).digest('hex')
  if (manifest.sha256 !== sha256) throw new Error('manifest SHA-256 does not match the canonical tarball')
  if (basename(tarballPath) !== manifest.artifact_filename) throw new Error('canonical tarball filename does not match the manifest')
  return { tarballPath, manifest }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, revision] = process.argv.slice(2)
  if (!directory || !version || !revision) throw new Error('usage: validate-canonical-artifact.mjs <directory> <version> <revision>')
  console.log(JSON.stringify(await validateCanonicalArtifact(directory, { version, revision }), null, 2))
}
