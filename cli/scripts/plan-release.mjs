import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const PACKAGE_NAME = '@swiveltechnologies/swico'

// These are the repository inputs that can change the npm package or its
// generated output. Release-only checks and generated dist files are not
// release triggers by themselves.
export const RELEASE_WORTHY_PATHS = Object.freeze([
  'cli/src/',
  'cli/package.json',
  'cli/package-lock.json',
  'cli/README.md',
  'cli/LICENSE',
  'cli/LICENSE_SCOPE.md',
  'cli/THIRD_PARTY_NOTICES.md',
  'cli/scripts/build.mjs',
  'cli/tsconfig.json',
])

export function isReleaseWorthyPath(path) {
  return RELEASE_WORTHY_PATHS.some(prefix => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix)
}

export function releaseWorthyChanges(paths) {
  return paths.filter(isReleaseWorthyPath)
}

function stableVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ''))
  return match ? match.slice(1).map(Number) : null
}

function compareVersions(left, right) {
  const a = stableVersion(left)
  const b = stableVersion(right)
  if (!a || !b) throw new Error(`automatic patch releases require stable semver versions: ${left}, ${right}`)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function patchVersion(version) {
  const parsed = stableVersion(version)
  if (!parsed) throw new Error(`cannot calculate a patch release from ${version}`)
  return `${parsed[0]}.${parsed[1]}.${parsed[2] + 1}`
}

export function planRelease({ repoVersion, npmLatestVersion, changedPaths, targetExists = false }) {
  const changed = releaseWorthyChanges(changedPaths)
  if (changed.length === 0) return { action:'skip', reason:'No Swico CLI package release required.', changedPaths:[] }

  const versionOrder = compareVersions(repoVersion, npmLatestVersion)
  if (versionOrder < 0) throw new Error(`version regression: repository ${repoVersion} is older than npm latest ${npmLatestVersion}`)

  const version = versionOrder > 0 ? repoVersion : patchVersion(npmLatestVersion)
  if (targetExists) return { action:'skip', reason:`${PACKAGE_NAME}@${version} already exists on npm; refusing to overwrite it.`, changedPaths:changed, version }
  return {
    action: 'release',
    reason: versionOrder > 0 ? `Reusing pending release ${version}.` : `Planning automatic patch release ${npmLatestVersion} → ${version}.`,
    version,
    changedPaths: changed,
    needsVersionCommit: versionOrder === 0,
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const changedFile = argumentValue(args, '--changed-files-file')
  const changedPaths = changedFile ? (await readFile(changedFile, 'utf8')).split(/\r?\n/).map(path => path.trim()).filter(Boolean) : []
  const plan = planRelease({
    repoVersion: argumentValue(args, '--repo-version'),
    npmLatestVersion: argumentValue(args, '--npm-latest-version'),
    changedPaths,
    targetExists: args.includes('--target-exists'),
  })
  process.stdout.write(`${JSON.stringify(plan)}\n`)
}
