#!/usr/bin/env node
/*
 * Verifies that the production native llama.cpp runtime is present and buildable.
 *
 * This script is intentionally stricter than the app's development fallback:
 * release/production native_on_device builds must link llama.cpp and must not
 * compile with JAI_LLAMA_CPP_AVAILABLE=0.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const mobileRoot = path.resolve(__dirname, '..');
const moduleRoot = path.join(mobileRoot, 'modules', 'jai-on-device-model');
const androidCppRoot = path.join(moduleRoot, 'android', 'src', 'main', 'cpp');
const androidCMakeFile = path.join(androidCppRoot, 'CMakeLists.txt');
const androidGradleFile = path.join(moduleRoot, 'android', 'build.gradle');
const iosPodspecFile = path.join(moduleRoot, 'ios', 'JaiOnDeviceModel.podspec');
const appConfigFile = path.join(mobileRoot, 'app.config.ts');
const readmeFile = path.join(mobileRoot, 'README.md');

const defaultLlamaDir = path.join(moduleRoot, 'vendor', 'llama.cpp');
const llamaDir = process.env.JAI_LLAMA_CPP_DIR
  ? path.resolve(mobileRoot, process.env.JAI_LLAMA_CPP_DIR)
  : defaultLlamaDir;
const llamaHeader = path.join(llamaDir, 'include', 'llama.h');
const llamaCMake = path.join(llamaDir, 'CMakeLists.txt');
const PENDING_NATIVE_STATUS = 'native_build_wired_requires_llama_cpp_for_production_gguf_runtime_not_verified_until_native_verify_llama_passes';
const VERIFIED_NATIVE_STATUS = 'native_build_verified_by_native_verify_llama_llama_cpp_linkable_production_gguf_runtime_target_device_gguf_generation_required';

const results = [];

function log(message) {
  console.log(`[verify-native-llama-runtime] ${message}`);
}

function pass(message) {
  results.push({ ok: true, message });
  log(`✅ ${message}`);
}

function fail(message, details = '') {
  console.error(`\n[verify-native-llama-runtime] ❌ ${message}`);
  if (details) {
    console.error(details.trim());
  }
  console.error('');
  process.exit(1);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`Could not read ${path.relative(repoRoot, file)}`, String(error && error.message ? error.message : error));
  }
}

function requireFile(file, description) {
  if (!fs.existsSync(file)) {
    fail(`${description} is missing`, `Expected: ${file}`);
  }
  pass(`${description} exists (${path.relative(repoRoot, file)})`);
}

function requireContains(file, content, needle, description) {
  if (!content.includes(needle)) {
    fail(`${description} is missing`, `File: ${path.relative(repoRoot, file)}\nExpected to find: ${needle}`);
  }
  pass(description);
}

function requirePattern(file, content, pattern, description) {
  if (!pattern.test(content)) {
    fail(`${description} is missing`, `File: ${path.relative(repoRoot, file)}\nExpected to match: ${pattern}`);
  }
  pass(description);
}

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], {
    shell: false,
    stdio: 'ignore',
    timeout: 10000,
  });
  return result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || Number(process.env.JAI_NATIVE_VERIFY_TIMEOUT_MS || 180000),
    maxBuffer: Number(process.env.JAI_NATIVE_VERIFY_MAX_BUFFER || 20 * 1024 * 1024),
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
    error: result.error,
  };
}

function assertRunSuccess(command, args, description, options = {}) {
  const result = run(command, args, options);
  if (result.error || result.status !== 0) {
    fail(`${description} failed`, [
      `Command: ${command} ${args.join(' ')}`,
      result.error ? `Error: ${result.error.message}` : '',
      result.output,
    ].filter(Boolean).join('\n'));
  }
  pass(description);
  return result;
}

function assertRunFailure(command, args, description, expectedOutputPattern, options = {}) {
  const result = run(command, args, options);
  if (result.status === 0) {
    fail(`${description} unexpectedly succeeded`, `Command: ${command} ${args.join(' ')}`);
  }
  if (expectedOutputPattern && !expectedOutputPattern.test(result.output)) {
    fail(
      `${description} failed for the wrong reason`,
      [
        `Command: ${command} ${args.join(' ')}`,
        `Expected output to match: ${expectedOutputPattern}`,
        result.output,
      ].join('\n'),
    );
  }
  pass(description);
  return result;
}

function assertOrder(content, first, second, description) {
  const firstIndex = content.indexOf(first);
  const secondIndex = content.indexOf(second);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    fail(
      description,
      `Expected "${first}" to appear before "${second}". first=${firstIndex}, second=${secondIndex}`,
    );
  }
  pass(description);
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jai-${label}-`));
}

function verifyRequiredFiles() {
  requireFile(llamaHeader, 'llama.cpp public header');
  requireFile(llamaCMake, 'llama.cpp CMake project');
  requireFile(androidCMakeFile, 'Android native CMakeLists.txt');
  requireFile(androidGradleFile, 'Android Gradle build file');
  requireFile(iosPodspecFile, 'iOS podspec');
}

function verifyAndroidStaticConfig() {
  const cmake = read(androidCMakeFile);
  const gradle = read(androidGradleFile);

  requireContains(
    androidCMakeFile,
    cmake,
    'set(JAI_REQUIRE_LLAMA_CPP OFF CACHE BOOL',
    'Android CMake exposes JAI_REQUIRE_LLAMA_CPP configure guard',
  );
  requireContains(
    androidCMakeFile,
    cmake,
    'target_compile_definitions(jai_llama_runtime PRIVATE JAI_LLAMA_CPP_AVAILABLE=1)',
    'Android CMake sets JAI_LLAMA_CPP_AVAILABLE=1 when llama.cpp is found',
  );
  requireContains(
    androidCMakeFile,
    cmake,
    'target_compile_definitions(jai_llama_runtime PRIVATE JAI_LLAMA_CPP_AVAILABLE=0)',
    'Android CMake has a dev-only missing-backend definition',
  );
  requireContains(
    androidCMakeFile,
    cmake,
    'target_link_libraries(jai_llama_runtime PRIVATE llama)',
    'Android CMake links the llama.cpp llama target',
  );
  requireContains(
    androidCMakeFile,
    cmake,
    'message(FATAL_ERROR',
    'Android CMake fails configure when llama.cpp is required but missing',
  );

  requireContains(
    androidGradleFile,
    gradle,
    "def requireLlamaCpp = runtimeMode == 'native_on_device' && productionOrReleaseBuild",
    'Android Gradle requires llama.cpp for production/release native_on_device builds',
  );
  requireContains(
    androidGradleFile,
    gradle,
    "arguments \"-DJAI_REQUIRE_LLAMA_CPP=${requireLlamaCpp ? 'ON' : 'OFF'}\"",
    'Android Gradle passes JAI_REQUIRE_LLAMA_CPP to CMake',
  );
  requireContains(
    androidGradleFile,
    gradle,
    'Refusing to compile with JAI_LLAMA_CPP_AVAILABLE=0',
    'Android Gradle refuses production/release native builds with JAI_LLAMA_CPP_AVAILABLE=0',
  );
}

function verifyAndroidCMakeConfigure() {
  if (!commandExists('cmake')) {
    fail('cmake is required for native llama.cpp verification. Install CMake before release builds.');
  }

  const buildDir = makeTempDir('llama-cmake-present');
  log('Running Android CMake configure probe with JAI_REQUIRE_LLAMA_CPP=ON');
  assertRunSuccess(
    'cmake',
    [
      '-S', androidCppRoot,
      '-B', buildDir,
      '-DJAI_REQUIRE_LLAMA_CPP=ON',
      '-DJAI_VERIFY_LLAMA_CPP_CONFIGURE_ONLY=ON',
      `-DJAI_LLAMA_CPP_DIR=${llamaDir}`,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY',
      '-DCMAKE_C_COMPILER_WORKS=ON',
      '-DCMAKE_CXX_COMPILER_WORKS=ON',
    ],
    'Android CMake configures with JAI_REQUIRE_LLAMA_CPP=ON and the synced llama.cpp checkout',
    { stdio: 'inherit' },
  );

  const cache = read(path.join(buildDir, 'CMakeCache.txt'));
  requireContains(
    path.join(buildDir, 'CMakeCache.txt'),
    cache,
    'JAI_REQUIRE_LLAMA_CPP:BOOL=ON',
    'Android CMake cache records JAI_REQUIRE_LLAMA_CPP=ON',
  );

  const missingDir = path.join(makeTempDir('llama-cmake-missing'), 'missing-llama.cpp');
  log('Running Android CMake missing-llama negative probe');
  const missingBuildDir = makeTempDir('llama-cmake-missing-build');
  assertRunFailure(
    'cmake',
    [
      '-S', androidCppRoot,
      '-B', missingBuildDir,
      '-DJAI_REQUIRE_LLAMA_CPP=ON',
      '-DJAI_VERIFY_LLAMA_CPP_CONFIGURE_ONLY=ON',
      `-DJAI_LLAMA_CPP_DIR=${missingDir}`,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY',
      '-DCMAKE_C_COMPILER_WORKS=ON',
      '-DCMAKE_CXX_COMPILER_WORKS=ON',
    ],
    'Android CMake rejects JAI_REQUIRE_LLAMA_CPP=ON when llama.cpp is missing',
    null,
    { stdio: 'inherit' },
  );

  if (!process.env.JAI_KEEP_NATIVE_VERIFY_BUILD) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(missingDir), { recursive: true, force: true });
    fs.rmSync(missingBuildDir, { recursive: true, force: true });
  } else {
    log(`Keeping CMake verify dirs because JAI_KEEP_NATIVE_VERIFY_BUILD is set: ${buildDir}, ${missingBuildDir}`);
  }
}

function buildRubyPodspecProbe(expectAvailable) {
  const expectedDefinition = expectAvailable
    ? 'JAI_LLAMA_CPP_AVAILABLE=1'
    : 'JAI_LLAMA_CPP_AVAILABLE=0';
  return `
module Pod
  class Spec
    def self.new
      spec = allocate
      yield spec
      $jai_native_verify_spec = spec
      spec
    end

    def dependency(*args)
      (@dependencies ||= []) << args
    end

    def method_missing(name, *args)
      key = name.to_s
      if key.end_with?('=')
        instance_variable_set('@' + key[0...-1], args.first)
      else
        instance_variable_get('@' + key)
      end
    end

    def respond_to_missing?(_name, _include_private = false)
      true
    end
  end
end

load ARGV.fetch(0)
xcconfig = $jai_native_verify_spec.pod_target_xcconfig || {}
definitions = xcconfig.fetch('GCC_PREPROCESSOR_DEFINITIONS', '').to_s
unless definitions.include?('${expectedDefinition}')
  raise "Expected podspec GCC_PREPROCESSOR_DEFINITIONS to include ${expectedDefinition}, got: #{definitions}"
end
if '${expectedDefinition}' == 'JAI_LLAMA_CPP_AVAILABLE=1'
  preserve_paths = Array($jai_native_verify_spec.preserve_paths)
  source_files = Array($jai_native_verify_spec.source_files)
  combined = (preserve_paths + source_files).join(' ')
  if combined.strip.empty?
    raise "Expected podspec to preserve or compile llama.cpp paths when the checkout is present"
  end
end
puts "podspec resolved ${expectedDefinition}"
`;
}

function runRubyProbe(env, expectAvailable, description, expectFailurePattern = null) {
  if (!commandExists('ruby')) {
    fail('ruby is required to verify the iOS podspec resolution. Install Ruby/CocoaPods tooling before release builds.');
  }

  const probeDir = makeTempDir('llama-podspec-probe');
  const probeFile = path.join(probeDir, 'probe.rb');
  fs.writeFileSync(probeFile, buildRubyPodspecProbe(expectAvailable));

  try {
    const args = [probeFile, iosPodspecFile];
    if (expectFailurePattern) {
      assertRunFailure('ruby', args, description, expectFailurePattern, { env });
    } else {
      assertRunSuccess('ruby', args, description, { env });
    }
  } finally {
    if (!process.env.JAI_KEEP_NATIVE_VERIFY_BUILD) {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }
}

function verifyIosPodspec() {
  const podspec = read(iosPodspecFile);
  requireContains(
    iosPodspecFile,
    podspec,
    "default_llama_dir = File.join(module_root, 'vendor', 'llama.cpp')",
    'iOS podspec resolves the vendored llama.cpp path',
  );
  requireContains(
    iosPodspecFile,
    podspec,
    "File.exist?(llama_header) && File.exist?(llama_cmake)",
    'iOS podspec checks both include/llama.h and CMakeLists.txt',
  );
  requireContains(
    iosPodspecFile,
    podspec,
    'JAI_LLAMA_CPP_AVAILABLE=1',
    'iOS podspec sets JAI_LLAMA_CPP_AVAILABLE=1 when llama.cpp is present',
  );
  requireContains(
    iosPodspecFile,
    podspec,
    'JAI_LLAMA_CPP_AVAILABLE=0',
    'iOS podspec has a dev-only missing-backend definition',
  );
  requireContains(
    iosPodspecFile,
    podspec,
    'Refusing to compile with JAI_LLAMA_CPP_AVAILABLE=0',
    'iOS podspec refuses production/release native builds with JAI_LLAMA_CPP_AVAILABLE=0',
  );

  runRubyProbe(
    {
      JAI_LLAMA_CPP_DIR: llamaDir,
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: 'native_on_device',
      JAI_BUILD_TYPE: 'release',
      JAI_REQUIRE_LLAMA_CPP: '1',
    },
    true,
    'iOS podspec resolves llama.cpp and emits JAI_LLAMA_CPP_AVAILABLE=1 when the checkout is present',
  );

  const missingDir = path.join(makeTempDir('llama-podspec-missing'), 'missing-llama.cpp');
  runRubyProbe(
    {
      JAI_LLAMA_CPP_DIR: missingDir,
      EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE: 'native_on_device',
      JAI_BUILD_TYPE: 'release',
      JAI_REQUIRE_LLAMA_CPP: '1',
    },
    false,
    'iOS podspec rejects production/release native_on_device builds when llama.cpp is missing',
    /requires llama\.cpp|Refusing to compile with JAI_LLAMA_CPP_AVAILABLE=0/i,
  );

  if (!process.env.JAI_KEEP_NATIVE_VERIFY_BUILD) {
    fs.rmSync(path.dirname(missingDir), { recursive: true, force: true });
  }
}

function verifyProductionGuardsAndDocs() {
  const appConfig = read(appConfigFile);
  const readme = read(readmeFile);

  requireContains(
    appConfigFile,
    appConfig,
    'isProductionNativeOnDeviceBuild && !hasUsableLlamaCppCheckout',
    'Expo config checks llama.cpp before production/release native prebuild',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'Refusing to ship with JAI_LLAMA_CPP_AVAILABLE=0',
    'Expo config refuses production/release native builds with JAI_LLAMA_CPP_AVAILABLE=0',
  );
  requireContains(
    appConfigFile,
    appConfig,
    'local_adapter is development-only',
    'Expo config keeps local_adapter development-only for production/release builds',
  );

  requireContains(
    readmeFile,
    readme,
    'npm run native:verify-llama',
    'README documents npm run native:verify-llama',
  );
  requireContains(
    readmeFile,
    readme,
    'npm run native:sync-llama\nnpm run native:verify-llama',
    'README documents CI/release sync then verify order',
  );
}

function verifyBuildApkOrder() {
  const buildApk = read(path.join(repoRoot, 'build-apk.sh'));
  requireContains(
    path.join(repoRoot, 'build-apk.sh'),
    buildApk,
    'npm run native:verify-llama',
    'build-apk.sh invokes native llama.cpp verification',
  );
  assertOrder(
    buildApk,
    'npm run native:sync-llama',
    'npm run native:verify-llama',
    'build-apk.sh runs native:sync-llama before native:verify-llama',
  );
  assertOrder(
    buildApk,
    'npm run native:verify-llama',
    'npx expo prebuild --platform android --clean',
    'build-apk.sh runs native:verify-llama before Android prebuild',
  );
}

function verifyStatusCanOnlyClaimAfterVerification() {
  const modelConfigFile = path.join(mobileRoot, 'data', 'config', 'models.json');
  const agentRegistryFile = path.join(mobileRoot, 'data', 'config', 'agent_registry.json');
  const workspaceManifestFile = path.join(mobileRoot, 'data', 'config', 'workspace_manifest.json');
  const localAgentsFile = path.join(mobileRoot, 'lib', 'localAgents.ts');

  for (const file of [modelConfigFile, agentRegistryFile, workspaceManifestFile, localAgentsFile]) {
    const content = read(file);
    requirePattern(
      file,
      content,
      /native_(?:build_)?verified_by_native_verify_llama|native:verify-llama|not_verified_until_native_verify_llama_passes/,
      `${path.relative(repoRoot, file)} status references native verification instead of zip-only trust`,
    );
  }
}

function replaceNativeStatusInText(content) {
  const quotedStatusPattern = /nativeImplementationStatus:\s*"[^"]+"/g;
  return content.replace(
    quotedStatusPattern,
    `nativeImplementationStatus: "${VERIFIED_NATIVE_STATUS}"`,
  );
}

function writeJsonRuntimeStatus(file) {
  const raw = read(file);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Could not parse ${path.relative(repoRoot, file)} while updating nativeImplementationStatus`, String(error && error.message ? error.message : error));
  }
  parsed.runtime = parsed.runtime || {};
  parsed.runtime.nativeImplementationStatus = VERIFIED_NATIVE_STATUS;
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  pass(`${path.relative(repoRoot, file)} nativeImplementationStatus updated after verification`);
}

function updateNativeImplementationStatusAfterVerification() {
  const modelConfigFile = path.join(mobileRoot, 'data', 'config', 'models.json');
  const agentRegistryFile = path.join(mobileRoot, 'data', 'config', 'agent_registry.json');
  const workspaceManifestFile = path.join(mobileRoot, 'data', 'config', 'workspace_manifest.json');
  const localAgentsFile = path.join(mobileRoot, 'lib', 'localAgents.ts');

  writeJsonRuntimeStatus(modelConfigFile);
  writeJsonRuntimeStatus(agentRegistryFile);
  writeJsonRuntimeStatus(workspaceManifestFile);

  const before = read(localAgentsFile);
  const after = replaceNativeStatusInText(before);
  if (after === before) {
    fail(
      `Could not update nativeImplementationStatus in ${path.relative(repoRoot, localAgentsFile)}`,
      'Expected at least one nativeImplementationStatus string literal.',
    );
  }
  fs.writeFileSync(localAgentsFile, after);
  pass(`${path.relative(repoRoot, localAgentsFile)} fallback nativeImplementationStatus updated after verification`);
}


function main() {
  log(`Using mobile root: ${mobileRoot}`);
  log(`Using llama.cpp checkout: ${llamaDir}`);

  verifyRequiredFiles();
  verifyAndroidStaticConfig();
  verifyAndroidCMakeConfigure();
  verifyIosPodspec();
  verifyBuildApkOrder();
  verifyProductionGuardsAndDocs();
  verifyStatusCanOnlyClaimAfterVerification();
  updateNativeImplementationStatusAfterVerification();

  log(`✅ Native llama.cpp runtime verification passed (${results.length} checks).`);
  log('This proves llama.cpp is present, CMake can configure it with JAI_REQUIRE_LLAMA_CPP=ON, iOS podspec resolves it, and production/release native_on_device builds cannot ship with JAI_LLAMA_CPP_AVAILABLE=0. Real GGUF generation still requires running the app on target devices with downloaded model files.');
}

main();
