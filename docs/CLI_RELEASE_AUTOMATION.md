# Swico CLI release automation

The stable package is `@swiveltechnologies/swico` and the executable is
`swico`. The current published stable version is `0.2.4`; this automation does
not republish it.

## Normal patch releases

For an ordinary CLI change, the owner workflow is only:

```text
git commit
git push origin main
```

After successful normal CI, GitHub compares the complete range since the
published package revision. Release-worthy CLI changes receive the next patch
version automatically. Web-only, documentation-only, CI-only, generated
`cli/dist/`, and CLI-test-only changes finish successfully with no npm
publication attempt.

The automatic workflow creates `chore(cli): release Swico CLI X.Y.Z`, changes
only `cli/package.json` and `cli/package-lock.json`, verifies the exact release
commit on Ubuntu, macOS, and Windows, creates a flat two-file canonical
artifact, and publishes that exact tarball through npm Trusted Publishing.

## Manual/emergency fallback

Keep this script for recovery, an explicitly prepared pending release, or an
operator-directed emergency. It is not part of the normal patch-release path.
Run from a clean `main` checkout at the repository root:

```sh
./scripts/release-swico-cli.sh patch
```

The script fetches `origin/main`, refuses a dirty or behind/diverged checkout,
updates `cli/package.json` and `cli/package-lock.json` with npm's version
machinery, runs locked CLI validation and the release check, and verifies the
expected tarball name. It never publishes and never creates a tag. `minor`,
`major`, and an explicit semver such as `0.2.1` are also supported.

Use `./scripts/release-swico-cli.sh patch --dry-run` to inspect the calculated
next version without fetching, changing package files, or requiring a clean
working tree. A real preparation still requires a clean checkout and a
current `main` branch.

After reviewing the two metadata changes, the operator may use the push option
only as a manual fallback:

```sh
./scripts/release-swico-cli.sh patch --push
```

That commits `chore(cli): release Swico CLI X.Y.Z` and pushes `main`. No npm
credential is stored locally. Normal CI and protected publication gates must
pass before publication.

## Trusted publication workflow

`.github/workflows/publish-cli.yml` runs only after the `CI` workflow completes
successfully for `main`. It reads the public npm latest package with scripts
disabled, inspects only its bounded `dist/build_identity.js`, compares the
published revision with the complete Git range, and validates the exact
automatically generated release commit. It publishes the exact flat canonical
tarball, never a local operator build.

Stable automatic patch versions always use the `latest` tag. Prereleases are
not part of this automatic flow.

The GitHub environment is `npm-production`. FULL AUTO means the environment
exists without a required reviewer. SAFE AUTO means it has a required reviewer
and GitHub pauses for one approval click. Both modes work with this workflow;
the repository does not silently choose the account policy.

Before the first future publication, configure npm Trusted Publishing at
**npmjs.com → Packages → @swiveltechnologies/swico → Settings → Trusted
Publisher**:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization/user | `swivelit` |
| Repository | `ai_tool` |
| Workflow filename | `publish-cli.yml` |
| Environment | `npm-production` |
| Permission | `npm publish` |

Use Node 22.14.0 with npm 11.5.1 as required by npm Trusted Publishing. The
workflow requests `contents: write` for its bot version commit, `actions: read`,
and `id-token: write`; it does not use `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or a
long-lived publish token.

## Release sequence and safeguards

The intended sequence is:

```text
source commit/push → normal CI → automatic patch version commit → exact
release matrix → flat canonical artifact → optional npm-production approval
→ exact-artifact OIDC publication
```

Stable release planning reuses a pending repository version when it is newer
than npm latest, fails closed on a repository version regression, and never
overwrites an existing npm version. A future explicit GitHub UI workflow can
accept `release_type: patch | minor | major`; this pass does not infer minor or
major changes from arbitrary code.

The automation does not alter backend access or rollout flags.
