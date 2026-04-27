#!/usr/bin/env node
/*
 * Ensures the native JaiOnDeviceModel module has a llama.cpp checkout at the
 * production build path:
 *   mobile/modules/jai-on-device-model/vendor/llama.cpp
 *
 * Preferred flow is a committed git submodule:
 *   git submodule update --init --recursive mobile/modules/jai-on-device-model/vendor/llama.cpp
 *
 * GitHub source ZIPs do not include submodule contents or gitlink checkout
 * metadata. In that case this script falls back to cloning the same pinned
 * llama.cpp commit into the same path.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const mobileRoot = path.resolve(__dirname, '..');
const llamaDir = path.join(mobileRoot, 'modules', 'jai-on-device-model', 'vendor', 'llama.cpp');
const llamaHeader = path.join(llamaDir, 'include', 'llama.h');
const llamaCMake = path.join(llamaDir, 'CMakeLists.txt');
const llamaRepo = process.env.JAI_LLAMA_CPP_REPO || 'https://github.com/ggml-org/llama.cpp.git';
const pinnedLlamaRef = 'f53577432541bb9edc1588c4ef45c66bf07e4468';
const llamaRef = process.env.JAI_LLAMA_CPP_REF || pinnedLlamaRef;
const submodulePath = 'mobile/modules/jai-on-device-model/vendor/llama.cpp';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  return result.status === 0;
}

function hasUsableCheckout() {
  return fs.existsSync(llamaHeader) && fs.existsSync(llamaCMake);
}

function gitOutput(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: process.env,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function hasCommittedGitlink() {
  const result = gitOutput(['ls-files', '--stage', submodulePath]);
  return result.ok && /^160000\s/.test(result.stdout.trim());
}

function fail(message) {
  console.error(`\n[sync-llama-cpp] ${message}\n`);
  process.exit(1);
}

if (hasUsableCheckout()) {
  console.log(`[sync-llama-cpp] llama.cpp already present at ${llamaDir}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(llamaDir), { recursive: true });

if (hasCommittedGitlink()) {
  console.log('[sync-llama-cpp] Trying git submodule update...');
  run('git', ['submodule', 'update', '--init', '--recursive', submodulePath]);
} else {
  console.log('[sync-llama-cpp] .gitmodules is present, but no gitlink is committed for llama.cpp yet. Using clone fallback for this checkout.');
}

if (hasUsableCheckout()) {
  console.log(`[sync-llama-cpp] llama.cpp submodule ready at ${llamaDir}`);
  process.exit(0);
}

if (fs.existsSync(llamaDir) && fs.readdirSync(llamaDir).length > 0) {
  fail(`${llamaDir} exists but is not a usable llama.cpp checkout. Expected include/llama.h and CMakeLists.txt. Remove/fix the directory, then rerun this script.`);
}

console.log(`[sync-llama-cpp] No initialized submodule found. Cloning ${llamaRepo}...`);
console.log(`[sync-llama-cpp] GitHub source ZIPs do not include submodule contents. This clone fallback will checkout llama.cpp ref ${llamaRef}.`);
const cloneArgs = ['clone', '--depth', '1', llamaRepo, llamaDir];

if (!run('git', cloneArgs)) {
  fail('Could not fetch llama.cpp. Check network access, git installation, or configure the repository as a submodule and run git submodule update --init --recursive.');
}

if (llamaRef) {
  console.log(`[sync-llama-cpp] Checking out JAI_LLAMA_CPP_REF=${llamaRef}...`);
  if (!run('git', ['fetch', '--depth', '1', 'origin', llamaRef], { cwd: llamaDir })) {
    fail(`Cloned llama.cpp but could not fetch JAI_LLAMA_CPP_REF=${llamaRef}. Pin a branch, tag, or fetchable commit.`);
  }
  if (!run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: llamaDir })) {
    fail(`Fetched llama.cpp ref ${llamaRef}, but could not checkout FETCH_HEAD.`);
  }
}

run('git', ['submodule', 'update', '--init', '--recursive'], { cwd: llamaDir });

if (!hasUsableCheckout()) {
  fail(`Fetched ${llamaDir}, but include/llama.h or CMakeLists.txt is still missing.`);
}

console.log(`[sync-llama-cpp] llama.cpp ready at ${llamaDir}`);
