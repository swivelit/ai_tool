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

function isTruthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function printUsage() {
  console.log(`Usage: npm run native:verify-llama -- [options]

Options:
  --smoke                         After native compile checks, build and run a host GGUF smoke probe.
  --model <path>                  GGUF model used by --smoke for completeChat and, by default, embedTexts.
  --embedding-model <path>        Optional separate GGUF model used by --smoke for embedTexts.
  --android-abi <abi>             Android ABI for the NDK compile probe (default: arm64-v8a).
  --android-platform <api>        Android platform for the NDK compile probe (default: android-24).
  --help                          Show this help message.

Examples:
  npm run native:verify-llama
  npm run native:verify-llama -- --smoke --model /path/to/tiny.gguf
  npm run native:verify-llama -- --smoke --model /path/to/tiny-chat.gguf --embedding-model /path/to/tiny-embed.gguf
`);
}

function parseArgs(args) {
  const options = {
    help: false,
    smoke: false,
    smokeModel: process.env.JAI_NATIVE_VERIFY_SMOKE_MODEL || '',
    smokeEmbeddingModel: process.env.JAI_NATIVE_VERIFY_SMOKE_EMBEDDING_MODEL || '',
    androidAbi: process.env.JAI_NATIVE_VERIFY_ANDROID_ABI || 'arm64-v8a',
    androidPlatform: process.env.JAI_NATIVE_VERIFY_ANDROID_PLATFORM || 'android-24',
  };

  function readValue(index, flag) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`${flag} requires a value`);
    }
    return value;
  }

  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--smoke') {
      options.smoke = true;
    } else if (arg === '--model') {
      options.smokeModel = readValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--model=')) {
      options.smokeModel = arg.slice('--model='.length);
    } else if (arg === '--embedding-model') {
      options.smokeEmbeddingModel = readValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--embedding-model=')) {
      options.smokeEmbeddingModel = arg.slice('--embedding-model='.length);
    } else if (arg === '--android-abi') {
      options.androidAbi = readValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--android-abi=')) {
      options.androidAbi = arg.slice('--android-abi='.length);
    } else if (arg === '--android-platform') {
      options.androidPlatform = readValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--android-platform=')) {
      options.androidPlatform = arg.slice('--android-platform='.length);
    } else {
      fail(`Unknown native verification option: ${arg}`, 'Run `npm run native:verify-llama -- --help` for supported options.');
    }
  }

  return options;
}

function cmakePath(value) {
  return String(value).replace(/\\/g, '/').replace(/"/g, '\\"');
}

function cmakeGeneratorArgs() {
  return commandExists('ninja') ? ['-G', 'Ninja'] : [];
}

function parallelBuildArgs() {
  const cpuCount = Array.isArray(os.cpus()) && os.cpus().length ? os.cpus().length : 2;
  return ['--', '-j', String(Math.max(1, Math.min(cpuCount, 8)))];
}

function fileExists(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function dirExists(dir) {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function androidNdkToolchainFile(ndkDir) {
  return path.join(ndkDir, 'build', 'cmake', 'android.toolchain.cmake');
}

function isUsableAndroidNdk(ndkDir) {
  return Boolean(ndkDir) && fileExists(androidNdkToolchainFile(ndkDir));
}

function compareVersionLikeNames(a, b) {
  const left = String(a).split(/[^0-9]+/).filter(Boolean).map((part) => Number(part));
  const right = String(b).split(/[^0-9]+/).filter(Boolean).map((part) => Number(part));
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; ++i) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta;
  }
  return String(a).localeCompare(String(b));
}

function findAndroidNdk() {
  const explicitCandidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.NDK_HOME,
  ].filter(Boolean).map((candidate) => path.resolve(candidate));

  for (const candidate of explicitCandidates) {
    if (isUsableAndroidNdk(candidate)) {
      return candidate;
    }
  }

  const sdkCandidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    '/opt/android-sdk',
    '/usr/local/lib/android/sdk',
  ].filter(Boolean).map((candidate) => path.resolve(candidate));

  for (const sdkRoot of sdkCandidates) {
    const ndkBundle = path.join(sdkRoot, 'ndk-bundle');
    if (isUsableAndroidNdk(ndkBundle)) {
      return ndkBundle;
    }

    const ndkRoot = path.join(sdkRoot, 'ndk');
    if (!dirExists(ndkRoot)) {
      continue;
    }

    const versions = fs.readdirSync(ndkRoot)
      .map((name) => path.join(ndkRoot, name))
      .filter(isUsableAndroidNdk)
      .sort((left, right) => compareVersionLikeNames(path.basename(right), path.basename(left)));
    if (versions.length > 0) {
      return versions[0];
    }
  }

  return null;
}

function findFiles(root, predicate, limit = 20) {
  const matches = [];
  const stack = [root];
  while (stack.length > 0 && matches.length < limit) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        matches.push(fullPath);
        if (matches.length >= limit) break;
      }
    }
  }
  return matches;
}

function assertNonEmptyFile(file, description) {
  if (!fileExists(file)) {
    fail(`${description} was not produced`, `Expected file: ${file}`);
  }
  const size = fs.statSync(file).size;
  if (size <= 0) {
    fail(`${description} is empty`, `File: ${file}`);
  }
  pass(`${description} exists and is non-empty (${path.relative(repoRoot, file)})`);
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


function verifyAndroidCMakeCompile(options) {
  if (!commandExists('cmake')) {
    fail('cmake is required for Android native compile verification. Install CMake before release builds.');
  }

  const ndkDir = findAndroidNdk();
  if (!ndkDir) {
    fail(
      'Android NDK is required for native llama.cpp compile verification.',
      'Install the Android NDK and set ANDROID_NDK_HOME, ANDROID_NDK_ROOT, or ANDROID_SDK_ROOT/ANDROID_HOME so the verifier can find ndk/<version>/build/cmake/android.toolchain.cmake.',
    );
  }

  const buildDir = makeTempDir('llama-android-ndk-build');
  const abi = options.androidAbi || 'arm64-v8a';
  const platform = options.androidPlatform || 'android-24';
  const toolchainFile = androidNdkToolchainFile(ndkDir);

  log(`Running Android NDK compile/link probe for ${abi} (${platform}) with NDK: ${ndkDir}`);
  try {
    assertRunSuccess(
      'cmake',
      [
        ...cmakeGeneratorArgs(),
        '-S', androidCppRoot,
        '-B', buildDir,
        `-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`,
        `-DANDROID_ABI=${abi}`,
        `-DANDROID_PLATFORM=${platform}`,
        '-DANDROID_STL=c++_shared',
        '-DJAI_REQUIRE_LLAMA_CPP=ON',
        `-DJAI_LLAMA_CPP_DIR=${llamaDir}`,
        '-DCMAKE_BUILD_TYPE=Release',
      ],
      'Android CMake configures a real NDK build with JAI_REQUIRE_LLAMA_CPP=ON',
      { stdio: 'inherit', timeoutMs: Number(process.env.JAI_NATIVE_VERIFY_ANDROID_CONFIGURE_TIMEOUT_MS || 300000) },
    );

    assertRunSuccess(
      'cmake',
      [
        '--build', buildDir,
        '--target', 'jai_llama_runtime',
        '--config', 'Release',
        ...parallelBuildArgs(),
      ],
      'Android NDK compiles and links jai_llama_runtime against llama.cpp',
      { stdio: 'inherit', timeoutMs: Number(process.env.JAI_NATIVE_VERIFY_ANDROID_BUILD_TIMEOUT_MS || 900000) },
    );

    const outputs = findFiles(buildDir, (file) => path.basename(file) === 'libjai_llama_runtime.so', 5);
    if (outputs.length === 0) {
      fail(
        'Android NDK compile probe did not produce libjai_llama_runtime.so',
        `Build directory: ${buildDir}`,
      );
    }
    assertNonEmptyFile(outputs[0], 'Android native llama.cpp bridge library');
  } finally {
    if (!process.env.JAI_KEEP_NATIVE_VERIFY_BUILD) {
      fs.rmSync(buildDir, { recursive: true, force: true });
    } else {
      log(`Keeping Android NDK verify build dir because JAI_KEEP_NATIVE_VERIFY_BUILD is set: ${buildDir}`);
    }
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


function verifyIosNativeCompile() {
  const requireIosNativeCompile =
    isTruthy(process.env.JAI_REQUIRE_IOS_NATIVE_COMPILE) ||
    ['ios', 'all'].includes(String(process.env.JAI_NATIVE_VERIFY_PLATFORM || '').trim().toLowerCase());

  if (process.platform !== 'darwin') {
    if (requireIosNativeCompile) {
      fail('iOS compile verification requires macOS with Xcode and the iPhone simulator SDK.');
    }
    log('iOS compile verification was skipped because the host is not macOS. Podspec structural checks still ran; macOS CI/release builds must run this verifier on macOS so JaiLlamaCppBridge.mm is compiled against llama.cpp.');
    pass('iOS compile verification skipped on non-macOS host with an explicit release note');
    return;
  }

  if (!commandExists('xcrun')) {
    if (requireIosNativeCompile) {
      fail('xcrun is required for iOS native compile verification on macOS. Install Xcode command line tools before iOS release builds.');
    }
    log('iOS compile verification was skipped because xcrun is unavailable. Podspec structural checks still ran; set JAI_REQUIRE_IOS_NATIVE_COMPILE=1 in iOS CI/release builds.');
    pass('iOS compile verification skipped because xcrun is unavailable and not explicitly required');
    return;
  }

  const bridgeFile = path.join(moduleRoot, 'ios', 'JaiLlamaCppBridge.mm');
  requireFile(bridgeFile, 'iOS Objective-C++ llama.cpp bridge');

  const sdkResult = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
  if (sdkResult.error || sdkResult.status !== 0) {
    if (requireIosNativeCompile) {
      fail(
        'iOS simulator SDK is required for iOS native compile verification.',
        sdkResult.output,
      );
    }
    log('iOS compile verification was skipped because the iPhone simulator SDK is unavailable. Podspec structural checks still ran; set JAI_REQUIRE_IOS_NATIVE_COMPILE=1 in iOS CI/release builds.');
    pass('iOS compile verification skipped because the iPhone simulator SDK is unavailable and not explicitly required');
    return;
  }

  const clangResult = run('xcrun', ['--sdk', 'iphonesimulator', '--find', 'clang++']);
  if (clangResult.error || clangResult.status !== 0) {
    if (requireIosNativeCompile) {
      fail(
        'Apple clang++ is required for iOS native compile verification.',
        clangResult.output,
      );
    }
    log('iOS compile verification was skipped because Apple clang++ is unavailable for the iPhone simulator SDK. Podspec structural checks still ran; set JAI_REQUIRE_IOS_NATIVE_COMPILE=1 in iOS CI/release builds.');
    pass('iOS compile verification skipped because Apple clang++ is unavailable and not explicitly required');
    return;
  }
  pass('iOS simulator SDK is available for native compile verification');
  pass('Apple clang++ is available for iOS native compile verification');

  const sdkPath = sdkResult.stdout.trim();
  const clangPath = clangResult.stdout.trim();
  const buildDir = makeTempDir('llama-ios-compile');
  const objectFile = path.join(buildDir, 'JaiLlamaCppBridge.o');
  const target = process.env.JAI_IOS_VERIFY_TARGET || (os.arch() === 'arm64'
    ? 'arm64-apple-ios15.1-simulator'
    : 'x86_64-apple-ios15.1-simulator');

  log(`Running iOS Objective-C++ compile probe for ${target}`);
  try {
    assertRunSuccess(
      clangPath,
      [
        '-x', 'objective-c++',
        '-std=c++17',
        '-target', target,
        '-mios-simulator-version-min=15.1',
        '-isysroot', sdkPath,
        '-fobjc-arc',
        '-fexceptions',
        '-frtti',
        '-DJAI_LLAMA_CPP_AVAILABLE=1',
        '-DGGML_USE_ACCELERATE=1',
        '-DGGML_USE_CPU=1',
        '-I', path.join(moduleRoot, 'ios'),
        '-I', path.join(llamaDir, 'include'),
        '-I', path.join(llamaDir, 'src'),
        '-I', path.join(llamaDir, 'ggml', 'include'),
        '-I', path.join(llamaDir, 'ggml', 'src'),
        '-I', path.join(llamaDir, 'ggml', 'src', 'ggml-cpu'),
        '-c', bridgeFile,
        '-o', objectFile,
      ],
      'iOS Objective-C++ bridge compiles against llama.cpp headers with JAI_LLAMA_CPP_AVAILABLE=1',
      { stdio: 'inherit', timeoutMs: Number(process.env.JAI_NATIVE_VERIFY_IOS_COMPILE_TIMEOUT_MS || 300000) },
    );
    assertNonEmptyFile(objectFile, 'iOS Objective-C++ bridge object file');
  } finally {
    if (!process.env.JAI_KEEP_NATIVE_VERIFY_BUILD) {
      fs.rmSync(buildDir, { recursive: true, force: true });
    } else {
      log(`Keeping iOS verify build dir because JAI_KEEP_NATIVE_VERIFY_BUILD is set: ${buildDir}`);
    }
  }
}

function buildSmokeProbeSource() {
  return String.raw`#include "llama.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <exception>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

class SmokeError : public std::runtime_error {
 public:
  explicit SmokeError(const std::string &message) : std::runtime_error(message) {}
};

struct ModelDeleter {
  void operator()(llama_model *model) const {
    if (model != nullptr) llama_model_free(model);
  }
};

struct ContextDeleter {
  void operator()(llama_context *ctx) const {
    if (ctx != nullptr) llama_free(ctx);
  }
};

struct BatchDeleter {
  void operator()(llama_batch *batch) const {
    if (batch != nullptr) {
      llama_batch_free(*batch);
      delete batch;
    }
  }
};

struct SamplerDeleter {
  void operator()(llama_sampler *sampler) const {
    if (sampler != nullptr) llama_sampler_free(sampler);
  }
};

using ModelPtr = std::unique_ptr<llama_model, ModelDeleter>;
using ContextPtr = std::unique_ptr<llama_context, ContextDeleter>;
using BatchPtr = std::unique_ptr<llama_batch, BatchDeleter>;
using SamplerPtr = std::unique_ptr<llama_sampler, SamplerDeleter>;

ModelPtr loadModel(const char *modelPath) {
  llama_model_params params = llama_model_default_params();
  params.use_mmap = llama_supports_mmap();
  params.use_mlock = false;
  params.check_tensors = false;
  params.n_gpu_layers = 0;

  llama_model *model = llama_model_load_from_file(modelPath, params);
  if (model == nullptr) {
    throw SmokeError(std::string("Could not load GGUF model: ") + modelPath);
  }
  return ModelPtr(model);
}

ContextPtr createContext(llama_model *model, bool embeddings) {
  llama_context_params params = llama_context_default_params();
  params.n_ctx = 128;
  params.n_batch = 64;
  params.n_ubatch = 64;
  params.n_seq_max = 1;
  params.n_threads = 1;
  params.n_threads_batch = 1;
  params.embeddings = embeddings;
  params.no_perf = true;
  if (embeddings) {
    params.pooling_type = LLAMA_POOLING_TYPE_MEAN;
    params.attention_type = LLAMA_ATTENTION_TYPE_NON_CAUSAL;
  }

  llama_context *ctx = llama_init_from_model(model, params);
  if (ctx == nullptr) {
    throw SmokeError("Could not create llama.cpp context");
  }
  llama_set_n_threads(ctx, 1, 1);
  return ContextPtr(ctx);
}

std::vector<llama_token> tokenize(llama_model *model, const std::string &text, bool addSpecial, bool parseSpecial) {
  const llama_vocab *vocab = llama_model_get_vocab(model);
  if (vocab == nullptr) {
    throw SmokeError("Model did not expose a vocabulary");
  }

  int32_t count = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()), nullptr, 0, addSpecial, parseSpecial);
  if (count < 0) count = -count;
  if (count <= 0) {
    throw SmokeError("Tokenization returned zero tokens");
  }

  std::vector<llama_token> tokens(static_cast<size_t>(count));
  int32_t actual = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()), tokens.data(), count, addSpecial, parseSpecial);
  if (actual < 0) {
    throw SmokeError("Tokenization failed after allocating token buffer");
  }
  tokens.resize(static_cast<size_t>(actual));
  return tokens;
}

BatchPtr makeBatch(const std::vector<llama_token> &tokens, bool logitsLastOnly) {
  auto batch = BatchPtr(new llama_batch(llama_batch_init(static_cast<int32_t>(tokens.size()), 0, 1)));
  for (size_t i = 0; i < tokens.size(); ++i) {
    batch->token[i] = tokens[i];
    batch->pos[i] = static_cast<llama_pos>(i);
    batch->n_seq_id[i] = 1;
    batch->seq_id[i][0] = 0;
    batch->logits[i] = logitsLastOnly && i + 1 == tokens.size() ? 1 : 0;
  }
  return batch;
}

void decode(llama_context *ctx, const std::vector<llama_token> &tokens, bool logitsLastOnly) {
  auto batch = makeBatch(tokens, logitsLastOnly);
  const int32_t status = llama_decode(ctx, *batch);
  if (status != 0) {
    throw SmokeError("llama_decode failed with status " + std::to_string(status));
  }
}

std::string tokenToPiece(llama_model *model, llama_token token) {
  const llama_vocab *vocab = llama_model_get_vocab(model);
  std::array<char, 256> stackBuffer{};
  int32_t written = llama_token_to_piece(vocab, token, stackBuffer.data(), static_cast<int32_t>(stackBuffer.size()), 0, false);
  if (written < 0) {
    std::vector<char> heapBuffer(static_cast<size_t>(-written));
    written = llama_token_to_piece(vocab, token, heapBuffer.data(), static_cast<int32_t>(heapBuffer.size()), 0, false);
    return written > 0 ? std::string(heapBuffer.data(), static_cast<size_t>(written)) : std::string();
  }
  return written > 0 ? std::string(stackBuffer.data(), static_cast<size_t>(written)) : std::string();
}

std::string completeChat(const char *modelPath) {
  auto model = loadModel(modelPath);
  auto ctx = createContext(model.get(), false);
  auto tokens = tokenize(model.get(), "Hello from the J AI native smoke test.", true, true);
  if (tokens.size() > 96) {
    tokens.erase(tokens.begin(), tokens.end() - 96);
  }
  decode(ctx.get(), tokens, true);

  SamplerPtr sampler(llama_sampler_init_greedy());
  if (!sampler) {
    throw SmokeError("Could not create greedy sampler");
  }

  llama_token sampled = llama_sampler_sample(sampler.get(), ctx.get(), -1);
  const llama_vocab *vocab = llama_model_get_vocab(model.get());
  if (sampled == LLAMA_TOKEN_NULL || llama_vocab_is_eog(vocab, sampled)) {
    return "<eog>";
  }
  llama_sampler_accept(sampler.get(), sampled);
  return tokenToPiece(model.get(), sampled);
}

std::vector<float> embedTexts(const char *modelPath) {
  auto model = loadModel(modelPath);
  auto ctx = createContext(model.get(), true);
  auto tokens = tokenize(model.get(), "embedding smoke", true, false);
  if (tokens.size() > 64) {
    tokens.resize(64);
  }
  decode(ctx.get(), tokens, true);

  float *embedding = llama_get_embeddings_seq(ctx.get(), 0);
  int32_t dimension = llama_model_n_embd(model.get());
#if defined(LLAMA_API)
  const int32_t outDimension = llama_model_n_embd_out(model.get());
  if (outDimension > 0) dimension = outDimension;
#endif
  if (embedding == nullptr) {
    embedding = llama_get_embeddings_ith(ctx.get(), -1);
  }
  if (embedding == nullptr || dimension <= 0) {
    throw SmokeError("llama.cpp did not return embeddings for the smoke input");
  }
  return std::vector<float>(embedding, embedding + dimension);
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 2 || argc > 3) {
    std::cerr << "Usage: jai_llama_smoke <chat.gguf> [embedding.gguf]" << std::endl;
    return 2;
  }

  try {
    llama_backend_init();
    const std::string generated = completeChat(argv[1]);
    const std::vector<float> embedding = embedTexts(argc >= 3 ? argv[2] : argv[1]);
    if (embedding.empty()) {
      throw SmokeError("embedTexts returned an empty vector");
    }
    std::cout << "completeChat smoke output: " << generated << std::endl;
    std::cout << "embedTexts smoke dimensions: " << embedding.size() << std::endl;
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "Native llama.cpp smoke test failed: " << error.what() << std::endl;
    return 1;
  }
}
`;
}

function buildSmokeProbeCMake() {
  return `cmake_minimum_required(VERSION 3.22.1)
project(jai_llama_smoke LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_LTO OFF CACHE BOOL "" FORCE)

set(JAI_LLAMA_CPP_DIR "${cmakePath(llamaDir)}" CACHE PATH "llama.cpp checkout")
if(NOT EXISTS "${cmakePath(llamaDir)}/CMakeLists.txt" OR NOT EXISTS "${cmakePath(llamaDir)}/include/llama.h")
  message(FATAL_ERROR "llama.cpp checkout is missing CMakeLists.txt or include/llama.h: ${cmakePath(llamaDir)}")
endif()

add_subdirectory("${cmakePath(llamaDir)}" llama_cpp_build EXCLUDE_FROM_ALL)
if(NOT TARGET llama)
  message(FATAL_ERROR "llama.cpp CMake target 'llama' was not created")
endif()

add_executable(jai_llama_smoke smoke.cpp)
target_compile_features(jai_llama_smoke PRIVATE cxx_std_17)
target_include_directories(jai_llama_smoke PRIVATE
  "${cmakePath(llamaDir)}/include"
  "${cmakePath(llamaDir)}/src"
  "${cmakePath(llamaDir)}/ggml/include"
  "${cmakePath(llamaDir)}/ggml/src"
)
target_link_libraries(jai_llama_smoke PRIVATE llama)
`;
}

function verifyRuntimeSmokeTest(options) {
  if (!options.smoke) {
    log('Optional GGUF runtime smoke test was not requested. To load a tiny GGUF and call completeChat + embedTexts, run: npm run native:verify-llama -- --smoke --model /path/to/tiny.gguf');
    return;
  }

  const chatModel = options.smokeModel ? path.resolve(options.smokeModel) : '';
  const embeddingModel = options.smokeEmbeddingModel ? path.resolve(options.smokeEmbeddingModel) : chatModel;
  if (!chatModel) {
    fail('--smoke requires --model /path/to/tiny.gguf');
  }
  requireFile(chatModel, 'GGUF smoke test chat model');
  requireFile(embeddingModel, 'GGUF smoke test embedding model');

  const sourceDir = makeTempDir('llama-smoke-src');
  const buildDir = makeTempDir('llama-smoke-build');
  fs.writeFileSync(path.join(sourceDir, 'CMakeLists.txt'), buildSmokeProbeCMake());
  fs.writeFileSync(path.join(sourceDir, 'smoke.cpp'), buildSmokeProbeSource());

  try {
    log('Building host GGUF runtime smoke probe against llama.cpp');
    assertRunSuccess(
      'cmake',
      [
        ...cmakeGeneratorArgs(),
        '-S', sourceDir,
        '-B', buildDir,
        '-DCMAKE_BUILD_TYPE=Release',
      ],
      'Host smoke CMake configures against llama.cpp',
      { stdio: 'inherit', timeoutMs: Number(process.env.JAI_NATIVE_VERIFY_SMOKE_CONFIGURE_TIMEOUT_MS || 300000) },
    );
    assertRunSuccess(
      'cmake',
      [
        '--build', buildDir,
        '--target', 'jai_llama_smoke',
        '--config', 'Release',
        ...parallelBuildArgs(),
      ],
      'Host smoke probe compiles and links against llama.cpp',
      { stdio: 'inherit', timeoutMs: Number(process.env.JAI_NATIVE_VERIFY_SMOKE_BUILD_TIMEOUT_MS || 900000) },
    );

    const exeName = process.platform === 'win32' ? 'jai_llama_smoke.exe' : 'jai_llama_smoke';
    const executables = findFiles(buildDir, (file) => path.basename(file) === exeName, 5);
    if (executables.length === 0) {
      fail('Host smoke probe executable was not produced', `Build directory: ${buildDir}`);
    }
    assertNonEmptyFile(executables[0], 'Host llama.cpp smoke executable');

    assertRunSuccess(
      executables[0],
      embeddingModel === chatModel ? [chatModel] : [chatModel, embeddingModel],
      'Host GGUF runtime smoke test loads a model and calls completeChat + embedTexts',
      { stdio: 'inherit', timeoutMs: Number(process.env.JAI_NATIVE_VERIFY_SMOKE_RUN_TIMEOUT_MS || 900000) },
    );
  } finally {
    if (!process.env.JAI_KEEP_NATIVE_VERIFY_BUILD) {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      fs.rmSync(buildDir, { recursive: true, force: true });
    } else {
      log(`Keeping smoke verify dirs because JAI_KEEP_NATIVE_VERIFY_BUILD is set: ${sourceDir}, ${buildDir}`);
    }
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
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  log(`Using mobile root: ${mobileRoot}`);
  log(`Using llama.cpp checkout: ${llamaDir}`);

  verifyRequiredFiles();
  verifyAndroidStaticConfig();
  verifyAndroidCMakeConfigure();
  verifyAndroidCMakeCompile(options);
  verifyIosPodspec();
  verifyIosNativeCompile();
  verifyBuildApkOrder();
  verifyProductionGuardsAndDocs();
  verifyStatusCanOnlyClaimAfterVerification();
  verifyRuntimeSmokeTest(options);
  updateNativeImplementationStatusAfterVerification();

  log(`✅ Native llama.cpp runtime verification passed (${results.length} checks).`);
  log('This proves llama.cpp is present; Android CMake configures with JAI_REQUIRE_LLAMA_CPP=ON; Android NDK compiles and links jai_llama_runtime against llama.cpp; iOS podspec resolves llama.cpp; iOS Objective-C++ bridge compilation ran when the iPhone simulator SDK was available or was explicitly skipped with a release note; and production/release native_on_device builds cannot ship with JAI_LLAMA_CPP_AVAILABLE=0. Use --smoke --model /path/to/tiny.gguf to additionally load a GGUF and call completeChat + embedTexts on the host. Target-device Gemma/Qwen validation still requires running the app on physical devices with downloaded model files.');
}

main();
