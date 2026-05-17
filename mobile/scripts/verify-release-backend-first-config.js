#!/usr/bin/env node
/*
 * Release guard for backend-first mobile routing.
 *
 * The backend AI router is the public default. Phone-local models remain
 * available only as explicit fallback/development paths.
 */
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const mobileRoot = path.resolve(__dirname, '..');
const appConfigFile = path.join(mobileRoot, 'app.config.ts');
const apiFile = path.join(mobileRoot, 'lib', 'api.ts');
const envExampleFile = path.join(mobileRoot, '.env.example');
const modelsConfigFile = path.join(mobileRoot, 'data', 'config', 'models.json');
const agentRegistryFile = path.join(mobileRoot, 'data', 'config', 'agent_registry.json');
const googleServicesFile = path.join(mobileRoot, 'google-services.json');

const FIREBASE_ENV_NAMES = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
];
const LOCAL_MODEL_BYTE_ENV_NAMES = [
  'EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B',
  'EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B',
  'EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B',
  'EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED',
];
const LOCAL_MODEL_SHA_ENV_NAMES = [
  'EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B',
  'EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B',
  'EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B',
  'EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED',
];
const LOCAL_MODEL_URL_ENV_NAMES = [
  'EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B',
  'EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B',
  'EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B',
  'EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED',
];

function rel(file) {
  return path.relative(repoRoot, file);
}

function log(message) {
  console.log(`[verify-release-backend-first-config] ${message}`);
}

function fail(message, details = '') {
  console.error(`\n[verify-release-backend-first-config] ${message}`);
  if (details) console.error(details.trim());
  console.error('');
  process.exit(1);
}

function pass(message) {
  log(`PASS ${message}`);
}

function verifyNoPublicEnvTypos() {
  const typoNames = Object.keys(process.env).filter((name) => name.startsWith('EEXPO_PUBLIC_'));
  if (!typoNames.length) return;
  const suggestions = typoNames
    .map((name) => `${name} is likely a typo for ${name.replace(/^EEXPO_PUBLIC_/, 'EXPO_PUBLIC_')}`)
    .join('\n');
  fail('Found malformed Expo public environment variable name(s)', suggestions);
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

function hasUsableLlamaCppCheckout(dir) {
  return fs.existsSync(path.join(dir, 'CMakeLists.txt')) && fs.existsSync(path.join(dir, 'include', 'llama.h'));
}

function isReleaseLike() {
  return (
    normalize(process.env.BUILD_TYPE) === 'release' ||
    normalize(process.env.JAI_BUILD_TYPE) === 'release' ||
    ['production', 'release'].includes(normalize(process.env.EAS_BUILD_PROFILE)) ||
    ['production', 'release'].includes(normalize(process.env.JAI_BUILD_PROFILE)) ||
    isTruthy(process.env.JAI_REQUIRE_RELEASE_BACKEND_FIRST_CONFIG)
  );
}

function verifyStaticBackendFirstConfig() {
  const appConfig = read(appConfigFile);
  const api = read(apiFile);
  const envExample = read(envExampleFile);
  const modelsConfig = readJson(modelsConfigFile);
  const agentRegistry = readJson(agentRegistryFile);

  requireContains(appConfigFile, appConfig, 'process.env.EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE ?? "false"', 'Expo config defaults chat to backend');
  requireContains(appConfigFile, appConfig, 'process.env.EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK ?? "false"', 'Expo config defaults local model fallback off');
  requireContains(appConfigFile, appConfig, 'LOCAL_MODEL_BACKEND_ROLE: "primary"', 'Expo config marks backend as primary');
  requireContains(apiFile, api, 'const USE_LOCAL_CHAT_PIPELINE_DEFAULT: boolean = false', 'API client default local chat flag is false');
  requireContains(apiFile, api, 'backendRole: "primary"', 'API routing banner reports backend primary');
  requireContains(envExampleFile, envExample, 'EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK=false', '.env.example defaults local model fallback off');
  requireContains(envExampleFile, envExample, 'EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=false', '.env.example defaults chat to backend');
  requireContains(envExampleFile, envExample, 'EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=false', '.env.example defaults voice to backend');

  if (modelsConfig.runtime?.backendRole !== 'primary') {
    fail('models.json runtime.backendRole must be primary');
  }
  if (modelsConfig.runtime?.openAiPolicy !== 'backend_controlled') {
    fail('models.json runtime.openAiPolicy must be backend_controlled');
  }
  if (agentRegistry.runtime?.backendRole !== 'primary') {
    fail('agent_registry.json runtime.backendRole must be primary');
  }
  if (agentRegistry.runtime?.openAiPolicy !== 'backend_controlled') {
    fail('agent_registry.json runtime.openAiPolicy must be backend_controlled');
  }
  pass('local model configs mark backend AI router as primary');
}

function verifyExplicitLocalFallbackReleaseEnvironment() {
  const localFallbackEnabled =
    isTruthy(process.env.EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK) ||
    isTruthy(process.env.JAI_REQUIRE_LLAMA_CPP);
  if (!localFallbackEnabled) {
    pass('release local model fallback remains disabled');
    return;
  }

  const llamaDir = process.env.JAI_LLAMA_CPP_DIR
    ? path.resolve(mobileRoot, process.env.JAI_LLAMA_CPP_DIR)
    : path.join(mobileRoot, 'modules', 'jai-on-device-model', 'vendor', 'llama.cpp');
  if (!hasUsableLlamaCppCheckout(llamaDir)) {
    fail(
      'Explicit local model fallback release requires a usable llama.cpp checkout',
      'Set JAI_LLAMA_CPP_DIR or run npm run native:sync-llama. Only variable names are shown here; values are intentionally omitted.',
    );
  }

  const missingBytes = LOCAL_MODEL_BYTE_ENV_NAMES.filter((name) => !String(process.env[name] || '').trim());
  const missingSha = LOCAL_MODEL_SHA_ENV_NAMES.filter((name) => !String(process.env[name] || '').trim());
  const hasCdnBase = String(process.env.EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL || process.env.EXPO_PUBLIC_MODEL_CDN_BASE_URL || '').trim();
  const missingUrls = hasCdnBase ? [] : LOCAL_MODEL_URL_ENV_NAMES.filter((name) => !String(process.env[name] || '').trim());
  const missing = [...missingUrls, ...missingBytes, ...missingSha];
  if (missing.length) {
    fail(
      'Explicit local model fallback release is missing GGUF delivery metadata',
      [
        'Only variable names are shown here; values are intentionally omitted.',
        `Missing variable name(s): ${missing.join(', ')}`,
      ].join('\n'),
    );
  }
  pass('explicit local model fallback release has llama.cpp and GGUF delivery metadata');
}

function verifyReleaseEnvironment() {
  if (!isReleaseLike()) {
    log('Release-only environment checks skipped. Set BUILD_TYPE=release, EAS_BUILD_PROFILE=production/release, or JAI_REQUIRE_RELEASE_BACKEND_FIRST_CONFIG=1 to enforce them.');
    return;
  }

  if (isTruthy(process.env.EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE)) {
    fail('Release backend-first builds must not set EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=true');
  }
  if (isTruthy(process.env.EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE) && !isTruthy(process.env.JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE)) {
    fail(
      'Release backend-first builds use backend Sarvam by default; set JAI_ALLOW_RELEASE_LOCAL_VOICE_PIPELINE=1 only for explicit experimental/development-style local voice builds',
    );
  }
  if (isTruthy(process.env.EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE)) {
    pass('local voice routing explicitly allowed; experimental/development-style build');
  } else {
    pass('release env uses backend Sarvam routing for voice');
  }
  pass('release env keeps chat on backend routing');

  const missingFirebaseEnvNames = FIREBASE_ENV_NAMES.filter((name) => !String(process.env[name] || '').trim());
  if (missingFirebaseEnvNames.length) {
    fail(
      'Release builds are missing Firebase public config',
      [
        'Only variable names are shown here; values are intentionally omitted.',
        `Missing variable name(s): ${missingFirebaseEnvNames.join(', ')}`,
      ].join('\n'),
    );
  }
  pass('release env has Firebase public config required by Firebase Auth');

  const hasGoogleServicesSource =
    fs.existsSync(googleServicesFile) ||
    String(process.env.GOOGLE_SERVICES_JSON_BASE64 || '').trim() ||
    String(process.env.GOOGLE_SERVICES_JSON || '').trim() ||
    String(process.env.FIREBASE_GOOGLE_SERVICES_JSON || '').trim();
  if (!hasGoogleServicesSource) {
    fail(
      'Release builds are missing Firebase Android google-services config',
      [
        'Provide mobile/google-services.json locally or set GOOGLE_SERVICES_JSON_BASE64, GOOGLE_SERVICES_JSON, or FIREBASE_GOOGLE_SERVICES_JSON in CI/EAS.',
        'Do not commit mobile/google-services.json; it is intentionally gitignored.',
      ].join('\n'),
    );
  }
  pass('release env has Firebase Android google-services config source');
  verifyExplicitLocalFallbackReleaseEnvironment();
}

verifyNoPublicEnvTypos();
verifyStaticBackendFirstConfig();
verifyReleaseEnvironment();
log('Backend-first release configuration verified.');
