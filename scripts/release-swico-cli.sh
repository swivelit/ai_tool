#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/release-swico-cli.sh <patch|minor|major|X.Y.Z> [--push] [--allow-non-main] [--dry-run]

Manual/emergency fallback: prepares a Swico CLI version bump, validates it, and
optionally commits/pushes only the two CLI package metadata files. Normal patch
releases are automatic after release-worthy CLI changes reach main. It never
publishes to npm.
EOF
}

die() {
  echo "release-swico-cli: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

if [[ "$(git rev-parse --show-toplevel 2>/dev/null || true)" != "$repo_root" ]]; then
  die "run this script from the repository checkout"
fi

if [[ $# -eq 1 && "$1" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

release_kind="$1"
shift
push_after_validation=false
allow_non_main=false
dry_run=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) push_after_validation=true ;;
    --allow-non-main) allow_non_main=true ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

for tool in git node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

branch="$(git branch --show-current)"
if [[ "$allow_non_main" != true && "$branch" != main ]]; then
  die "current branch is '$branch'; release preparation requires main (or --allow-non-main)"
fi
if [[ "$push_after_validation" == true && "$branch" != main ]]; then
  die "--push is allowed only from main"
fi

if [[ "$dry_run" != true && -n "$(git status --porcelain=v1)" ]]; then
  die "working tree is dirty; commit or stash unrelated changes before preparing a release"
fi

if [[ "$dry_run" != true ]]; then
  git remote get-url origin >/dev/null 2>&1 || die "origin remote is required"
  git fetch --prune origin main
  git merge-base --is-ancestor origin/main HEAD || die "HEAD is behind or has diverged from origin/main"
fi

[[ -f cli/package.json && -f cli/package-lock.json ]] || die "CLI package metadata is missing"

current_version="$(node -e "const p=require('./cli/package.json'); process.stdout.write(p.version)")"
package_name="$(node -e "const p=require('./cli/package.json'); process.stdout.write(p.name)")"
[[ "$package_name" == '@swiveltechnologies/swico' ]] || die "unexpected package name: $package_name"

next_version="$(CURRENT_VERSION="$current_version" RELEASE_KIND="$release_kind" node <<'NODE'
const current = process.env.CURRENT_VERSION;
const requested = process.env.RELEASE_KIND;
const stable = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
const explicit = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(requested);
if (!stable && !explicit) {
  console.error(`unsupported current or requested version: ${current} -> ${requested}`);
  process.exit(1);
}
if (explicit) {
  process.stdout.write(requested);
  process.exit(0);
}
let [, major, minor, patch] = stable.map(Number);
if (requested === 'patch') patch += 1;
else if (requested === 'minor') { minor += 1; patch = 0; }
else if (requested === 'major') { major += 1; minor = 0; patch = 0; }
else {
  console.error(`expected patch, minor, major, or an explicit semver: ${requested}`);
  process.exit(1);
}
process.stdout.write(`${major}.${minor}.${patch}`);
NODE
)"

if [[ "$dry_run" == true ]]; then
  printf 'release-swico-cli dry run\nold version: %s\nnew version: %s\npackage: %s\n' "$current_version" "$next_version" "$package_name"
  exit 0
fi

metadata_changed=false
committed=false
pack_json=''
restore_metadata() {
  local status=$?
  if [[ -n "$pack_json" ]]; then rm -f "$pack_json"; fi
  if [[ $status -ne 0 && "$metadata_changed" == true && "$committed" == false ]]; then
    git restore --source=HEAD -- cli/package.json cli/package-lock.json || true
  fi
  exit "$status"
}
trap restore_metadata EXIT

npm --prefix cli version "$next_version" --no-git-tag-version
metadata_changed=true

node - "$current_version" "$next_version" <<'NODE'
const fs = require('node:fs');
const [oldVersion, expectedVersion] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync('cli/package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('cli/package-lock.json', 'utf8'));
if (pkg.name !== '@swiveltechnologies/swico' || pkg.bin?.swico !== 'dist/cli.js') throw new Error('CLI package identity changed');
if (pkg.version !== expectedVersion || lock.version !== expectedVersion || lock.packages?.['']?.version !== expectedVersion) throw new Error('package and lock versions do not match');
if (pkg.version === oldVersion) throw new Error('version did not change');
NODE

changed_files="$(git diff --name-only)"
if [[ "$changed_files" != $'cli/package-lock.json\ncli/package.json' && "$changed_files" != $'cli/package.json\ncli/package-lock.json' ]]; then
  die "versioning changed files outside cli/package.json and cli/package-lock.json:\n${changed_files}"
fi

npm --prefix cli ci
npm --prefix cli run typecheck
npm --prefix cli run lint
npm --prefix cli test
npm --prefix cli run release:check

expected_tarball="swiveltechnologies-swico-${next_version}.tgz"
pack_json="$(mktemp "${TMPDIR:-/tmp}/swico-pack.XXXXXX.json")"
npm --prefix cli pack --json > "$pack_json"
PACK_JSON="$pack_json" EXPECTED_TARBALL="$expected_tarball" node <<'NODE'
const fs = require('node:fs');
const result = JSON.parse(fs.readFileSync(process.env.PACK_JSON, 'utf8'));
const entries = Array.isArray(result) ? result : [result];
const files = entries.map(entry => entry.filename).filter(Boolean);
if (files.length !== 1 || files[0] !== process.env.EXPECTED_TARBALL) {
  throw new Error(`unexpected tarball output: ${files.join(', ')}`);
}
NODE

echo "Prepared Swico CLI release"
echo "old version: $current_version"
echo "new version: $next_version"
echo "package: $package_name"
echo "expected tarball: $expected_tarball"
echo "changed files:"
git diff --name-only

if [[ "$push_after_validation" == true ]]; then
  git add cli/package.json cli/package-lock.json
  git commit -m "chore(cli): release Swico CLI $next_version"
  committed=true
  git push origin main
  echo "pushed main; CI must pass before any protected npm publication"
else
  echo "No commit or push performed. Review the metadata, then commit/push deliberately."
fi
