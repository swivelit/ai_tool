# Swico CLI release automation

The stable package is `@swiveltechnologies/swico` and the executable is
`swico`. The current published stable version is `0.2.0`; this automation does
not republish it.

## Prepare a future release

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

After reviewing the two metadata changes, the operator may use:

```sh
./scripts/release-swico-cli.sh patch --push
```

That commits `chore(cli): release Swico CLI X.Y.Z` and pushes `main`. Use this
only after review; no npm credential is stored locally. The normal CI must
pass before publication.

## Trusted publication workflow

`.github/workflows/publish-cli.yml` runs only after the `CI` workflow completes
successfully for `main`. It checks out the triggering `head_sha`, downloads the
canonical artifact from that exact CI run, validates its manifest, clean build
identity, SHA-256, package allowlist, and version, and refuses an already
published npm version. It publishes the exact downloaded tarball, never a
local rebuild.

Stable versions use the `latest` tag. Versions containing a prerelease suffix
use `beta`:

```sh
npm install -g @swiveltechnologies/swico@beta
```

The protected GitHub environment is `npm-production`; configure it under
**Repository Settings → Environments → New environment** and add the release
maintainer as a required reviewer. The workflow requests only `contents: read`,
`actions: read`, and `id-token: write` and does not use `NPM_TOKEN` or a
long-lived publish token.

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

Use Node 22 with npm 11.5.1 or newer as required by npm Trusted Publishing.
After verifying OIDC publication, tighten npm package settings to disallow
traditional long-lived publish tokens where appropriate. Trusted publishing is
operator configuration; this repository change does not prove it until a
future release exercises the workflow.

## Release sequence and safeguards

The intended sequence is:

```text
version bump → commit/push → seven normal CI checks → canonical artifact
→ npm-production approval → exact-artifact OIDC publication
```

The CI artifact job derives `release` for stable versions and
`release-candidate` for versions containing `-`. Stable publication uses
`latest`; prereleases use `beta`. The workflow does not publish `0.2.0`, does
not rename the package, and does not alter backend access or rollout flags.
