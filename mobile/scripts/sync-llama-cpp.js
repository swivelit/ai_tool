#!/usr/bin/env node
/*
 * Ensures the native JaiOnDeviceModel module has a llama.cpp checkout at the
 * production build path:
 *   mobile/modules/jai-on-device-model/vendor/llama.cpp
 *
 * Preferred flow is a committed git submodule:
 *   git submodule update --init --recursive mobile/modules/jai-on-device-model/vendor/llama.cpp
 *
 * For zip/checkouts that do not include gitlink metadata yet, this script falls
 * back to a shallow clone into the same path. Pin JAI_LLAMA_CPP_REF in CI if you
 * are not using a submodule commit.
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
const llamaRef = process.env.JAI_LLAMA_CPP_REF || '';

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

function fail(message) {
  console.error(`\n[sync-llama-cpp] ${message}\n`);
  process.exit(1);
}

if (hasUsableCheckout()) {
  console.log(`[sync-llama-cpp] llama.cpp already present at ${llamaDir}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(llamaDir), { recursive: true });

console.log('[sync-llama-cpp] Trying git submodule update...');
run('git', ['submodule', 'update', '--init', '--recursive', 'mobile/modules/jai-on-device-model/vendor/llama.cpp']);

if (hasUsableCheckout()) {
  console.log(`[sync-llama-cpp] llama.cpp submodule ready at ${llamaDir}`);
  process.exit(0);
}

if (fs.existsSync(llamaDir) && fs.readdirSync(llamaDir).length > 0) {
  fail(`${llamaDir} exists but is not a usable llama.cpp checkout. Expected include/llama.h and CMakeLists.txt. Remove/fix the directory, then rerun this script.`);
}

console.log(`[sync-llama-cpp] No initialized submodule found. Cloning ${llamaRepo}...`);
const cloneArgs = ['clone', '--depth', '1'];
if (llamaRef) {
  cloneArgs.push('--branch', llamaRef);
}
cloneArgs.push(llamaRepo, llamaDir);

if (!run('git', cloneArgs)) {
  fail('Could not fetch llama.cpp. Check network access, git installation, or configure the repository as a submodule and run git submodule update --init --recursive.');
}

if (llamaRef && !run('git', ['checkout', llamaRef], { cwd: llamaDir })) {
  fail(`Cloned llama.cpp but could not checkout JAI_LLAMA_CPP_REF=${llamaRef}.`);
}

run('git', ['submodule', 'update', '--init', '--recursive'], { cwd: llamaDir });

if (!hasUsableCheckout()) {
  fail(`Fetched ${llamaDir}, but include/llama.h or CMakeLists.txt is still missing.`);
}

console.log(`[sync-llama-cpp] llama.cpp ready at ${llamaDir}`);
