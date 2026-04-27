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
  "qwen3-embedding-0.6b-q8_0.gguf",
];
const ANDROID_NATIVE_ABIS = ["arm64-v8a"];
const ANDROID_ABI_FILTERS_TAG = "jai-on-device-model-android-abi-filters";
const ANDROID_ABI_FILTERS_BLOCK = `        // @generated begin ${ANDROID_ABI_FILTERS_TAG}
        ndk {
            abiFilters "arm64-v8a"
        }
        // @generated end ${ANDROID_ABI_FILTERS_TAG}
`;

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

function applyAndroidAppAbiFilters(contents) {
  const cleaned = removeGeneratedBlock(contents, ANDROID_ABI_FILTERS_TAG);
  const defaultConfigPattern = /(\n\s*defaultConfig\s*\{\n)/;

  if (!defaultConfigPattern.test(cleaned)) {
    throw new Error(
      "[withJaiOnDeviceModelAssets] Could not find android.defaultConfig in app/build.gradle to apply arm64-v8a ABI filters.",
    );
  }

  return cleaned.replace(defaultConfigPattern, `$1${ANDROID_ABI_FILTERS_BLOCK}`);
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
        "[withJaiOnDeviceModelAssets] Expected Groovy app/build.gradle so arm64-v8a ABI filters can be applied.",
      );
    }

    modConfig.modResults.contents = applyAndroidAppAbiFilters(modConfig.modResults.contents);
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

module.exports = function withJaiOnDeviceModelAssets(config) {
  config = withAndroidNativeAbiGradleProperties(config);
  config = withAndroidAppNativeAbiFilters(config);
  config = withAndroidModelAssets(config);
  config = withIosModelAssets(config);
  return config;
};
