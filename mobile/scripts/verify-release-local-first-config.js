#!/usr/bin/env node
/*
 * Release guard for the local-first mobile runtime.
 *
 * This script is intentionally metadata-focused and runs before Expo prebuild in
 * release builds. It complements native:verify-llama, which performs the native
 * CMake/NDK/podspec compile/link checks.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const mobileRoot = path.resolve(__dirname, '..');
const moduleRoot = path.join(mobileRoot, 'modules', 'jai-on-device-model');
const appConfigFile = path.join(mobileRoot, 'app.config.ts');
const modelsConfigFile = path.join(mobileRoot, 'data', 'config', 'models.json');
const nativeModuleFiles = [
  path.join(moduleRoot, 'index.ts'),
  path.join(moduleRoot, 'expo-module.config.json'),
  path.join(moduleRoot, 'android', 'build.gradle'),
  path.join(moduleRoot, 'android', 'src', 'main', 'cpp', 'CMakeLists.txt'),
  path.join(moduleRoot, 'android', 'src', 'main', 'cpp', 'jai_llama_runtime.cpp'),
  path.join(moduleRoot, 'ios', 'JaiOnDeviceModelModule.swift'),
  path.join(moduleRoot, 'ios', 'JaiLlamaCppBridge.h'),
  path.join(moduleRoot, 'ios', 'JaiLlamaCppBridge.mm'),
  path.join(moduleRoot, 'ios', 'JaiOnDeviceModel.podspec'),
];

const defaultLlamaDir = path.join(moduleRoot, 'vendor', 'llama.cpp');
const llamaDir = process.env.JAI_LLAMA_CPP_DIR
  ? path.resolve(mobileRoot, process.env.JAI_LLAMA_CPP_DIR)
  : defaultLlamaDir;

const REQUIRED_MODEL_IDS = [
  'google/gemma-3-4b-it',
  'Qwen/Qwen3-8B',
  'Qwen/Qwen3-14B',
  'Qwen/Qwen3-Embedding-0.6B',
];

const PER_MODEL_URL_ENV = {
  'google/gemma-3-4b-it': 'EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B',
  'Qwen/Qwen3-8B': 'EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B',
  'Qwen/Qwen3-14B': 'EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B',
  'Qwen/Qwen3-Embedding-0.6B': 'EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED',
};

const EXPECTED_BYTES_ENV = {
  'google/gemma-3-4b-it': 'EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B',
  'Qwen/Qwen3-8B': 'EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B',
  'Qwen/Qwen3-14B': 'EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B',
  'Qwen/Qwen3-Embedding-0.6B': 'EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED',
};

const SHA256_ENV = {
  'google/gemma-3-4b-it': 'EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B',
  'Qwen/Qwen3-8B': 'EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B',
  'Qwen/Qwen3-14B': 'EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B',
  'Qwen/Qwen3-Embedding-0.6B': 'EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED',
};

const PLACEHOLDER_URL_PATTERN = /^https:\/\/YOUR_MODEL_CDN\//i;
const CDN_URL_PATTERN = /^cdn:\/\//i;
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*(?:MODEL_CDN_BASE_URL|LOCAL_MODEL_CDN_BASE_URL)\s*\}\}/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const results = [];

function rel(file) {
  return path.relative(repoRoot, file);
}

function log(message) {
  console.log(`[verify-release-local-first-config] ${message}`);
}

function pass(message) {
  results.push(message);
  log(`✅ ${message}`);
}

function fail(message, details = '') {
  console.error(`\n[verify-release-local-first-config] ❌ ${message}`);
  if (details) console.error(details.trim());
  console.error('');
  process.exit(1);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`Could not read ${rel(file)}`, String(error && error.message ? error.message : error));
  }
}

function readJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    fail(`Could not parse ${rel(file)}`, String(error && error.message ? error.message : error));
  }
}

function requireFile(file, description) {
  if (!fs.existsSync(file)) {
    fail(`${description} is missing`, `Expected: ${file}`);
  }
  pass(`${description} exists (${rel(file)})`);
}

function requireContains(file, content, needle, description) {
  if (!content.includes(needle)) {
    fail(`${description} is missing`, `File: ${rel(file)}\nExpected to find: ${needle}`);
  }
  pass(description);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalize(value));
}

function isFalsey(value) {
  return ['0', 'false', 'no', 'n', 'off'].includes(normalize(value));
}

function env(name) {
  return String(process.env[name] || '').trim();
}

function isReleaseLike() {
  return (
    normalize(process.env.BUILD_TYPE) === 'release' ||
    normalize(process.env.JAI_BUILD_TYPE) === 'release' ||
    ['production', 'release'].includes(normalize(process.env.EAS_BUILD_PROFILE)) ||
    ['production', 'release'].includes(normalize(process.env.JAI_BUILD_PROFILE)) ||
    isTruthy(process.env.JAI_REQUIRE_LLAMA_CPP) ||
    isTruthy(process.env.JAI_REQUIRE_RELEASE_LOCAL_FIRST_CONFIG)
  );
}

function runtimeMode() {
  return normalize(process.env.EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE || 'native_on_device');
}

function deliveryMode() {
  return normalize(process.env.EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE || 'download_on_first_launch');
}

function validateUrl(name, value) {
  const url = String(value || '').trim();
  if (!url) fail(`${name} is empty`);
  if (PLACEHOLDER_URL_PATTERN.test(url)) fail(`${name} still uses YOUR_MODEL_CDN placeholder`, url);
  if (CDN_URL_PATTERN.test(url)) fail(`${name} is still a cdn:// placeholder`, url);
  if (TEMPLATE_TOKEN_PATTERN.test(url)) fail(`${name} still contains an unresolved CDN template token`, url);
  if (!/^https?:\/\//i.test(url)) fail(`${name} must be an http(s) URL`, url);
}

function validatePositiveInteger(name, value) {
  const normalized = String(value || '').trim().replace(/_/g, '');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${name} must be the exact positive integer byte size for the release GGUF file`, String(value || '<empty>'));
  }
}

function validateSha256(name, value) {
  if (!SHA256_PATTERN.test(String(value || '').trim())) {
    fail(`${name} must be the 64-character SHA-256 hex digest for the exact release GGUF file`, String(value || '<empty>'));
  }
}

function verifyStaticLocalFirstConfig() {
  requireFile(appConfigFile, 'Expo app config');
  requireFile(modelsConfigFile, 'Model delivery config');
  nativeModuleFiles.forEach((file) => requireFile(file, 'JaiOnDeviceModel native module file'));

  const appConfig = read(appConfigFile);
  requireContains(
    appConfigFile,
    appConfig,
    'process.env.EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE ?? "true"',
    'Expo config defaults EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE to true',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'Production/release builds must keep recorded voice on the local-first pipeline',
    'Expo config rejects release builds that disable local voice routing',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'LOCAL_MODEL_URL_GEMMA_4B',
    'Expo config exposes per-model URL metadata path',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'LOCAL_MODEL_BYTES_GEMMA_4B',
    'Expo config exposes per-model expectedBytes metadata path',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'LOCAL_MODEL_SHA256_GEMMA_4B',
    'Expo config exposes per-model sha256 metadata path',
  );

  const modelsConfig = readJson(modelsConfigFile);
  const delivery = modelsConfig.modelDelivery || {};
  const deliveryModels = Array.isArray(delivery.models) ? delivery.models : [];
  if (delivery.mode !== 'download_on_first_launch') {
    fail('models.json must default modelDelivery.mode to download_on_first_launch for production local-first installs');
  }
  if (delivery.requireIntegrityMetadataInProduction !== true) {
    fail('models.json must require integrity metadata in production');
  }

  for (const modelId of REQUIRED_MODEL_IDS) {
    const entry = deliveryModels.find((model) => model && model.id === modelId);
    if (!entry) fail(`models.json is missing required model delivery entry for ${modelId}`);
    if (entry.downloadUrlEnv !== PER_MODEL_URL_ENV[modelId]) {
      fail(`${modelId} downloadUrlEnv must be ${PER_MODEL_URL_ENV[modelId]}`);
    }
    if (entry.expectedBytesEnv !== EXPECTED_BYTES_ENV[modelId]) {
      fail(`${modelId} expectedBytesEnv must be ${EXPECTED_BYTES_ENV[modelId]}`);
    }
    if (entry.sha256Env !== SHA256_ENV[modelId]) {
      fail(`${modelId} sha256Env must be ${SHA256_ENV[modelId]}`);
    }
    if (entry.required !== true) {
      fail(`${modelId} must be marked required=true`);
    }
  }
  pass('models.json has release URL, expectedBytes, and sha256 environment paths for all required GGUF models');
}

function verifyReleaseEnvironment() {
  if (!isReleaseLike()) {
    log('Release-only environment checks skipped. Set BUILD_TYPE=release, JAI_BUILD_TYPE=release, EAS_BUILD_PROFILE=production/release, or JAI_REQUIRE_RELEASE_LOCAL_FIRST_CONFIG=1 to enforce them.');
    return;
  }

  if (runtimeMode() !== 'native_on_device') {
    fail('Release local-first builds must use EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE=native_on_device', runtimeMode());
  }

  if (deliveryMode() !== 'download_on_first_launch') {
    fail('Release local-first builds must use EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE=download_on_first_launch', deliveryMode());
  }

  const voiceValue = env('EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE') || 'true';
  if (!isTruthy(voiceValue) || isFalsey(voiceValue)) {
    fail('Release builds must set EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=true', voiceValue);
  }
  pass('release env keeps recorded voice on the local-first pipeline');

  requireFile(path.join(llamaDir, 'CMakeLists.txt'), 'llama.cpp CMake project');
  requireFile(path.join(llamaDir, 'include', 'llama.h'), 'llama.cpp public header');

  const cdnBaseUrl = env('EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL') || env('EXPO_PUBLIC_MODEL_CDN_BASE_URL');
  if (cdnBaseUrl) {
    validateUrl('EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL', cdnBaseUrl);
    pass('release env has a resolved model CDN base URL');
  } else {
    for (const modelId of REQUIRED_MODEL_IDS) {
      const name = PER_MODEL_URL_ENV[modelId];
      validateUrl(name, env(name));
    }
    pass('release env has resolved per-model GGUF URLs');
  }

  for (const modelId of REQUIRED_MODEL_IDS) {
    validatePositiveInteger(EXPECTED_BYTES_ENV[modelId], env(EXPECTED_BYTES_ENV[modelId]));
    validateSha256(SHA256_ENV[modelId], env(SHA256_ENV[modelId]));
  }
  pass('release env has exact expectedBytes and SHA-256 metadata for all required GGUF models');
}

function main() {
  log(`Using mobile root: ${mobileRoot}`);
  log(`Using llama.cpp checkout: ${llamaDir}`);
  verifyStaticLocalFirstConfig();
  verifyReleaseEnvironment();
  log(`✅ Local-first release configuration verification passed (${results.length} checks).`);
}

main();
