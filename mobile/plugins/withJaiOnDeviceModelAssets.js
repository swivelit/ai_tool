const fs = require("fs");
const path = require("path");
const {
  IOSConfig,
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
  withXcodeProject,
} = require("@expo/config-plugins");

const REQUIRED_GGUF_FILES = [
  "gemma-3-4b-it-q4_k_m.gguf",
  "qwen3-8b-q4_k_m.gguf",
  "qwen3-14b-q4_k_m.gguf",
  "minilm-l12-finetuned.gguf",
];
const DEFAULT_ANDROID_NATIVE_ABIS = ["arm64-v8a"];
const SUPPORTED_ANDROID_NATIVE_ABIS = new Set(["arm64-v8a", "x86_64"]);
const ANDROID_NATIVE_ABIS = getAndroidNativeAbis();
const ANDROID_ABI_FILTERS_TAG = "jai-on-device-model-android-abi-filters";
const ANDROID_16KB_CMAKE_TAG = "jai-on-device-model-android-16kb-cmake";

function parseAndroidNativeAbis(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return [...DEFAULT_ANDROID_NATIVE_ABIS];

  const selectedAbis = [];
  for (const abi of rawValue.split(/[,\s;]+/).map((entry) => entry.trim()).filter(Boolean)) {
    if (!SUPPORTED_ANDROID_NATIVE_ABIS.has(abi)) {
      throw new Error(
        `[withJaiOnDeviceModelAssets] Unsupported Android ABI "${abi}". ` +
          `Supported ABIs: ${[...SUPPORTED_ANDROID_NATIVE_ABIS].join(", ")}.`,
      );
    }

    if (!selectedAbis.includes(abi)) {
      selectedAbis.push(abi);
    }
  }

  return selectedAbis.length ? selectedAbis : [...DEFAULT_ANDROID_NATIVE_ABIS];
}

function getAndroidNativeAbis(env = process.env) {
  return parseAndroidNativeAbis(env.JAI_ANDROID_ABIS || env.ANDROID_ABIS || "");
}

function formatGradleAbiFilters(abis) {
  return abis.map((abi) => `"${abi}"`).join(", ");
}

function androidAbiFiltersBlock(abis) {
  return `        // @generated begin ${ANDROID_ABI_FILTERS_TAG}
        ndk {
            abiFilters ${formatGradleAbiFilters(abis)}
        }
        // @generated end ${ANDROID_ABI_FILTERS_TAG}
`;
}

function androidFlexiblePageSizeCMakeBlock() {
  return `        // @generated begin ${ANDROID_16KB_CMAKE_TAG}
        externalNativeBuild {
            cmake {
                arguments "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON"
            }
        }
        // @generated end ${ANDROID_16KB_CMAKE_TAG}
`;
}

function getProjectRoot(config) {
  return config.modRequest?.projectRoot || process.cwd();
}

function existingModelFiles(projectRoot) {
  const modelsDir = path.join(projectRoot, "models");
  if (!fs.existsSync(modelsDir)) return [];
  return REQUIRED_GGUF_FILES.map((fileName) => ({
    fileName,
    source: path.join(modelsDir, fileName),
  })).filter((entry) => {
    try {
      return fs.statSync(entry.source).isFile() && fs.statSync(entry.source).size > 0;
    } catch {
      return false;
    }
  });
}

function copyModelFiles(projectRoot, targetDir) {
  const files = existingModelFiles(projectRoot);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const { fileName, source } of files) {
    fs.copyFileSync(source, path.join(targetDir, fileName));
  }
  return files.map((entry) => entry.fileName);
}

function ensureIosResourcesGroup(project) {
  const groupName = "JaiOnDeviceModels";
  const existing = project.pbxGroupByName(groupName);
  if (existing) return existing.uuid;
  const group = project.addPbxGroup([], groupName, groupName);
  const resourcesGroup = project.pbxGroupByName("Resources");
  const mainGroup = project.getFirstProject().firstProject.mainGroup;
  const parentUuid = resourcesGroup?.uuid || mainGroup;
  project.addToPbxGroup(group.uuid, parentUuid);
  return group.uuid;
}

function addIosResourceFile(project, filePath, groupUuid) {
  const normalized = filePath.replace(/\\/g, "/");
  const fileName = path.basename(normalized);
  const alreadyAdded = Object.values(project.hash.project.objects.PBXFileReference || {}).some(
    (value) => value && typeof value === "object" && value.path === fileName,
  );
  if (alreadyAdded) return;
  project.addResourceFile(normalized, { lastKnownFileType: "file" }, groupUuid);
}

function upsertGradleProperty(properties, key, value) {
  const existing = properties.find((entry) => entry.type === "property" && entry.key === key);
  if (existing) {
    existing.value = value;
    return;
  }

  properties.push({ type: "property", key, value });
}

function removeGeneratedBlock(contents, tag) {
  const pattern = new RegExp(
    `\\n?[ \\t]*// @generated begin ${tag}\\n[\\s\\S]*?\\n[ \\t]*// @generated end ${tag}\\n?`,
    "g",
  );
  return contents.replace(pattern, "\n");
}

function applyAndroidAppAbiFilters(contents, androidNativeAbis = ANDROID_NATIVE_ABIS) {
  const cleaned = removeGeneratedBlock(contents, ANDROID_ABI_FILTERS_TAG);
  const defaultConfigPattern = /(\n\s*defaultConfig\s*\{\n)/;

  if (!defaultConfigPattern.test(cleaned)) {
    throw new Error(
      "[withJaiOnDeviceModelAssets] Could not find android.defaultConfig in app/build.gradle to apply Android ABI filters.",
    );
  }

  return cleaned.replace(defaultConfigPattern, `$1${androidAbiFiltersBlock(androidNativeAbis)}`);
}

function applyAndroidFlexiblePageSizeCMakeArgument(contents) {
  if (contents.includes("-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON")) {
    return removeGeneratedBlock(contents, ANDROID_16KB_CMAKE_TAG);
  }

  const cleaned = removeGeneratedBlock(contents, ANDROID_16KB_CMAKE_TAG);
  const defaultConfigPattern = /(\n\s*defaultConfig\s*\{\n)/;

  if (!defaultConfigPattern.test(cleaned)) {
    throw new Error(
      "[withJaiOnDeviceModelAssets] Could not find android.defaultConfig in app/build.gradle to apply Android 16 KB CMake flags.",
    );
  }

  return cleaned.replace(defaultConfigPattern, `$1${androidFlexiblePageSizeCMakeBlock()}`);
}

function withAndroidNativeAbiGradleProperties(config) {
  return withGradleProperties(config, (modConfig) => {
    upsertGradleProperty(
      modConfig.modResults,
      "reactNativeArchitectures",
      ANDROID_NATIVE_ABIS.join(","),
    );
    return modConfig;
  });
}

function withAndroidAppNativeAbiFilters(config) {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== "groovy") {
      throw new Error(
        "[withJaiOnDeviceModelAssets] Expected Groovy app/build.gradle so Android ABI filters can be applied.",
      );
    }

    modConfig.modResults.contents = applyAndroidFlexiblePageSizeCMakeArgument(
      applyAndroidAppAbiFilters(modConfig.modResults.contents),
    );
    return modConfig;
  });
}

function withAndroidModelAssets(config) {
  return withDangerousMod(config, ["android", async (modConfig) => {
    const projectRoot = getProjectRoot(modConfig);
    const targetDir = path.join(
      modConfig.modRequest.platformProjectRoot,
      "app",
      "src",
      "main",
      "assets",
      "models",
    );
    const copied = copyModelFiles(projectRoot, targetDir);
    if (!copied.length) {
      console.warn(
        "[withJaiOnDeviceModelAssets] No non-empty mobile/models/*.gguf files found. This is OK for modelDelivery.mode=download_on_first_launch; bundled_assets builds must provide the GGUF files before prebuild.",
      );
    }
    return modConfig;
  }]);
}

function withIosModelAssets(config) {
  config = withDangerousMod(config, ["ios", async (modConfig) => {
    const projectRoot = getProjectRoot(modConfig);
    const appName = IOSConfig.XcodeUtils.getProjectName(modConfig.modRequest.projectRoot);
    const targetDir = path.join(
      modConfig.modRequest.platformProjectRoot,
      appName,
      "JaiOnDeviceModels",
    );
    copyModelFiles(projectRoot, targetDir);
    return modConfig;
  }]);

  return withXcodeProject(config, (modConfig) => {
    const projectRoot = getProjectRoot(modConfig);
    const files = existingModelFiles(projectRoot);
    if (!files.length) return modConfig;

    const appName = IOSConfig.XcodeUtils.getProjectName(modConfig.modRequest.projectRoot);
    const project = modConfig.modResults;
    const groupUuid = ensureIosResourcesGroup(project);
    for (const { fileName } of files) {
      addIosResourceFile(project, `${appName}/JaiOnDeviceModels/${fileName}`, groupUuid);
    }
    return modConfig;
  });
}

function withJaiOnDeviceModelAssets(config) {
  config = withAndroidNativeAbiGradleProperties(config);
  config = withAndroidAppNativeAbiFilters(config);
  config = withAndroidModelAssets(config);
  config = withIosModelAssets(config);
  return config;
}

module.exports = withJaiOnDeviceModelAssets;
module.exports.parseAndroidNativeAbis = parseAndroidNativeAbis;
module.exports.getAndroidNativeAbis = getAndroidNativeAbis;
module.exports.applyAndroidAppAbiFilters = applyAndroidAppAbiFilters;
module.exports.applyAndroidFlexiblePageSizeCMakeArgument =
  applyAndroidFlexiblePageSizeCMakeArgument;
