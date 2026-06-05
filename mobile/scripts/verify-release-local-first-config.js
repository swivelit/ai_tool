#!/usr/bin/env node
/*
 * LEGACY ONLY: release guard for the old local-first mobile runtime.
 *
 * Public release verification must use verify-release-backend-first-config.js.
 * This script is retained for old local-model experiments and refuses to run
 * unless explicitly allowed.
 */
if (process.env.JAI_ALLOW_LEGACY_LOCAL_FIRST_VERIFY !== '1') {
  console.error('[verify-release-local-first-config] Legacy local-first release verification is disabled. Use npm run release:verify-backend-first.');
  process.exit(1);
}
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const mobileRoot = path.resolve(__dirname, '..');
const moduleRoot = path.join(mobileRoot, 'modules', 'jai-on-device-model');
const appConfigFile = path.join(mobileRoot, 'app.config.ts');
const modelsConfigFile = path.join(mobileRoot, 'data', 'config', 'models.json');
const agentRegistryFile = path.join(mobileRoot, 'data', 'config', 'agent_registry.json');
const syncLlamaScriptFile = path.join(mobileRoot, 'scripts', 'sync-llama-cpp.js');
const nativeModuleFiles = [
  path.join(moduleRoot, 'index.ts'),
  path.join(moduleRoot, 'expo-module.config.json'),
  path.join(moduleRoot, 'android', 'build.gradle'),
  path.join(moduleRoot, 'android', 'src', 'main', 'cpp', 'CMakeLists.txt'),
  path.join(moduleRoot, 'android', 'src', 'main', 'cpp', 'jai_llama_runtime.cpp'),
  path.join(moduleRoot, 'android', 'src', 'main', 'java', 'com', 'harishajahan', 'jai', 'ondevice', 'JaiLlamaCppBinding.kt'),
  path.join(moduleRoot, 'android', 'src', 'main', 'java', 'com', 'harishajahan', 'jai', 'ondevice', 'JaiOnDeviceModelEngine.kt'),
  path.join(moduleRoot, 'android', 'src', 'main', 'java', 'com', 'harishajahan', 'jai', 'ondevice', 'JaiOnDeviceModelModule.kt'),
  path.join(moduleRoot, 'ios', 'JaiOnDeviceModelModule.swift'),
  path.join(moduleRoot, 'ios', 'JaiLlamaCppBridge.h'),
  path.join(moduleRoot, 'ios', 'JaiLlamaCppBridge.mm'),
  path.join(moduleRoot, 'ios', 'JaiOnDeviceModel.podspec'),
];

const defaultLlamaDir = path.join(moduleRoot, 'vendor', 'llama.cpp');
const llamaDir = process.env.JAI_LLAMA_CPP_DIR
  ? path.resolve(mobileRoot, process.env.JAI_LLAMA_CPP_DIR)
  : defaultLlamaDir;

const PRODUCTION_MODEL_IDS = [
  'google/gemma-3-4b-it',
  'Qwen/Qwen3-8B',
  'Qwen/Qwen3-14B',
  'Qwen/Qwen3-Embedding-0.6B',
];
const DEFAULT_REQUIRED_MODEL_IDS = [
  'google/gemma-3-4b-it',
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

const FIREBASE_ENV_NAMES = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
];

const PLACEHOLDER_URL_PATTERN = /^https:\/\/YOUR_MODEL_CDN\//i;
const CDN_URL_PATTERN = /^cdn:\/\//i;
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*(?:MODEL_CDN_BASE_URL|LOCAL_MODEL_CDN_BASE_URL)\s*\}\}/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const LOCAL_ENV_FILES = ['.env', '.env.local'];
const LOCAL_ENV_ALLOWED_NAMES = new Set([
  'BUILD_TYPE',
  'EAS_BUILD_PROFILE',
]);
const LOCAL_ENV_ALLOWED_PREFIXES = [
  'EXPO_PUBLIC_',
  'EEXPO_PUBLIC_',
  'JAI_',
];

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

function requireUsableLlamaCppCheckout() {
  const cmakeFile = path.join(llamaDir, 'CMakeLists.txt');
  const headerFile = path.join(llamaDir, 'include', 'llama.h');
  if (fs.existsSync(cmakeFile) && fs.existsSync(headerFile)) {
    pass(`llama.cpp checkout exists (${rel(llamaDir)})`);
    return;
  }

  fail(
    'llama.cpp checkout is missing or incomplete',
    [
      `Expected: ${cmakeFile}`,
      `Expected: ${headerFile}`,
      'GitHub source ZIPs do not include submodule contents.',
      'Run `npm run native:sync-llama` from mobile/ before native verification, prebuild, or release builds.',
    ].join('\n'),
  );
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

function shouldLoadLocalEnvName(name) {
  return (
    LOCAL_ENV_ALLOWED_NAMES.has(name) ||
    LOCAL_ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function parseEnvValue(rawValue) {
  let value = String(rawValue || '').trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    return quote === '"' ? value.replace(/\\n/g, '\n').replace(/\\"/g, '"') : value;
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function loadLocalEnvFiles() {
  if (isTruthy(process.env.JAI_SKIP_LOCAL_ENV_FILES)) return;

  const shellEnvNames = new Set(Object.keys(process.env));
  const localValues = {};
  const loadedFiles = [];

  for (const fileName of LOCAL_ENV_FILES) {
    const file = path.join(mobileRoot, fileName);
    if (!fs.existsSync(file)) continue;
    loadedFiles.push(fileName);

    for (const line of read(file).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
      const equalsIndex = normalized.indexOf('=');
      if (equalsIndex <= 0) continue;

      const name = normalized.slice(0, equalsIndex).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !shouldLoadLocalEnvName(name)) {
        continue;
      }

      localValues[name] = parseEnvValue(normalized.slice(equalsIndex + 1));
    }
  }

  for (const [name, value] of Object.entries(localValues)) {
    if (!shellEnvNames.has(name)) {
      process.env[name] = value;
    }
  }

  if (loadedFiles.length) {
    log(`Loaded local env file(s) for verification: ${loadedFiles.join(', ')}. Existing shell variables keep precedence.`);
  }
}

function verifyPublicEnvNameTypos() {
  const typoNames = Object.keys(process.env)
    .filter((name) => name.startsWith('EEXPO_PUBLIC_'))
    .sort();

  if (!typoNames.length) {
    pass('environment variable names do not use the EEXPO_PUBLIC_ typo prefix');
    return;
  }

  const details = [
    'Only variable names are shown here; values are intentionally omitted.',
    `Mistyped variable name(s): ${typoNames.join(', ')}`,
  ];

  fail(
    'Found environment variables starting with EEXPO_PUBLIC_. Use EXPO_PUBLIC_ instead.',
    details.join('\n'),
  );
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
  requireFile(agentRegistryFile, 'Agent registry config');
  requireFile(syncLlamaScriptFile, 'llama.cpp sync script');
  nativeModuleFiles.forEach((file) => requireFile(file, 'JaiOnDeviceModel native module file'));

  const appConfig = read(appConfigFile);
  const syncScript = read(syncLlamaScriptFile);
  requireContains(
    appConfigFile,
    appConfig,
    'process.env.EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE ?? "false"',
    'Expo config defaults recorded voice to backend routing',
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
  requireContains(
    appConfigFile,
    appConfig,
    'FIREBASE_PUBLIC_ENV_NAMES',
    'Expo config declares required Firebase public env names',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'Release/production native builds require Firebase config',
    'Expo config rejects release builds with missing Firebase config',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'LOCAL_MODEL_OPENAI_POLICY: "fallback_only"',
    'Expo config keeps OpenAI policy fallback-only',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'LOCAL_MODEL_BACKEND_ROLE: "fallback_only"',
    'Expo config keeps backend role fallback-only',
  );
  requireContains(
    syncLlamaScriptFile,
    syncScript,
    'GitHub source ZIPs do not include submodule contents',
    'llama.cpp sync script documents source ZIP submodule behavior',
  );
  requireContains(
    syncLlamaScriptFile,
    syncScript,
    'git submodule update',
    'llama.cpp sync script supports git submodule checkout',
  );
  requireContains(
    syncLlamaScriptFile,
    syncScript,
    'clone fallback',
    'llama.cpp sync script supports ZIP/checkout clone fallback',
  );

  const modelsConfig = readJson(modelsConfigFile);
  const agentRegistry = readJson(agentRegistryFile);
  if (modelsConfig.runtime?.backendRole !== 'fallback_only') {
    fail('models.json runtime.backendRole must remain fallback_only');
  }
  if (modelsConfig.runtime?.openAiPolicy !== 'fallback_only') {
    fail('models.json runtime.openAiPolicy must remain fallback_only');
  }
  if (agentRegistry.runtime?.backendRole !== 'fallback_only') {
    fail('agent_registry.json runtime.backendRole must remain fallback_only');
  }
  if (agentRegistry.runtime?.openAiPolicy !== 'fallback_only') {
    fail('agent_registry.json runtime.openAiPolicy must remain fallback_only');
  }
  pass('backend/OpenAI policy remains fallback_only in local agent configs');

  const delivery = modelsConfig.modelDelivery || {};
  const deliveryModels = Array.isArray(delivery.models) ? delivery.models : [];
  if (delivery.mode !== 'download_on_first_launch') {
    fail('models.json must default modelDelivery.mode to download_on_first_launch for production local-first installs');
  }
  if (delivery.requireIntegrityMetadataInProduction !== true) {
    fail('models.json must require integrity metadata in production');
  }

  if (delivery.defaultTier !== 'lite') {
    fail('models.json must default modelDelivery.defaultTier to lite');
  }
  const liteRequired = delivery.modelTiers?.lite?.requiredModelIds || [];
  const proRequired = delivery.modelTiers?.pro?.requiredModelIds || [];
  for (const modelId of DEFAULT_REQUIRED_MODEL_IDS) {
    if (!liteRequired.includes(modelId)) {
      fail(`models.json Lite tier must require ${modelId}`);
    }
  }
  if (liteRequired.includes('Qwen/Qwen3-14B')) {
    fail('models.json Lite tier must not require Qwen/Qwen3-14B');
  }
  if (!proRequired.includes('Qwen/Qwen3-14B')) {
    fail('models.json Pro tier must be the only tier that requires Qwen/Qwen3-14B');
  }

  for (const modelId of PRODUCTION_MODEL_IDS) {
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
    const expectedRequired = DEFAULT_REQUIRED_MODEL_IDS.includes(modelId);
    if (entry.required !== expectedRequired) {
      fail(`${modelId} required must be ${expectedRequired} for first-launch Lite installs`);
    }
    if (modelId === 'Qwen/Qwen3-14B' && entry.required === true) {
      fail('Qwen/Qwen3-14B must not be marked required=true for first launch/basic chat');
    }
  }
  pass('models.json has tiered Lite/Standard/Pro delivery metadata and does not require 14B by default');

  const nativeModels = modelsConfig.native?.models || {};
  for (const modelId of PRODUCTION_MODEL_IDS) {
    const asset = nativeModels[modelId];
    if (!asset) fail(`native.models is missing ${modelId}`);
    if (asset.gpuLayers !== 0 || asset.useGpu !== false || asset.useMetal !== false) {
      fail(`${modelId} native config must be CPU-only while native llama.cpp sets n_gpu_layers=0`);
    }
    if (!asset.embedding && !asset.chatTemplate) {
      fail(`${modelId} chat model must declare chatTemplate`);
    }
  }
  const androidRuntime = read(path.join(moduleRoot, 'android', 'src', 'main', 'cpp', 'jai_llama_runtime.cpp'));
  const iosRuntime = read(path.join(moduleRoot, 'ios', 'JaiLlamaCppBridge.mm'));
  requireContains(
    path.join(moduleRoot, 'android', 'src', 'main', 'cpp', 'jai_llama_runtime.cpp'),
    androidRuntime,
    'model_params.n_gpu_layers = 0;',
    'Android native llama.cpp runtime is CPU-only',
  );
  requireContains(
    path.join(moduleRoot, 'ios', 'JaiLlamaCppBridge.mm'),
    iosRuntime,
    'modelParams.n_gpu_layers = 0;',
    'iOS native llama.cpp runtime is CPU-only',
  );
  pass('models.json CPU-only runtime config matches native llama.cpp initialization');
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

  const voiceValue = env('EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE') || 'false';
  if (isTruthy(voiceValue)) {
    if (!isTruthy(process.env.JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE)) {
      fail(
        'Release recorded voice should use backend Sarvam by default',
        [
          'EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=true enables local/native STT.',
          'Set JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE=1 only when intentionally shipping experimental/development-style release local/native voice routing.',
        ].join('\n'),
      );
    }
    log('⚠️  Release local/native voice routing is explicitly allowed; this is experimental/development-style routing.');
    pass('release env explicitly allows local/native voice routing with JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE');
  } else {
    pass('release env keeps recorded voice on backend Sarvam routing');
  }

  const missingFirebaseEnvNames = FIREBASE_ENV_NAMES.filter((name) => !env(name));
  if (missingFirebaseEnvNames.length) {
    fail(
      'Release builds are missing Firebase public config',
      [
        'Only variable names are shown here; values are intentionally omitted.',
        `Missing variable name(s): ${missingFirebaseEnvNames.join(', ')}`,
        'Set all EXPO_PUBLIC_FIREBASE_* values before expo config/prebuild/build.',
      ].join('\n'),
    );
  }
  pass('release env has Firebase public config required by Firebase Auth');

  requireUsableLlamaCppCheckout();

  const cdnBaseUrl = env('EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL') || env('EXPO_PUBLIC_MODEL_CDN_BASE_URL');
  if (cdnBaseUrl) {
    validateUrl('EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL', cdnBaseUrl);
    pass('release env has a resolved model CDN base URL');
  } else {
    for (const modelId of PRODUCTION_MODEL_IDS) {
      const name = PER_MODEL_URL_ENV[modelId];
      validateUrl(name, env(name));
    }
    pass('release env has resolved per-model GGUF URLs');
  }

  for (const modelId of PRODUCTION_MODEL_IDS) {
    validatePositiveInteger(EXPECTED_BYTES_ENV[modelId], env(EXPECTED_BYTES_ENV[modelId]));
    validateSha256(SHA256_ENV[modelId], env(SHA256_ENV[modelId]));
  }
  pass('release env has exact expectedBytes and SHA-256 metadata for all production GGUF models');
}

function main() {
  log(`Using mobile root: ${mobileRoot}`);
  log(`Using llama.cpp checkout: ${llamaDir}`);
  loadLocalEnvFiles();
  verifyPublicEnvNameTypos();
  verifyStaticLocalFirstConfig();
  verifyReleaseEnvironment();
  log(`✅ Local-first release configuration verification passed (${results.length} checks).`);
}

main();
