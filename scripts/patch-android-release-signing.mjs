#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const gradleFile = process.argv[2] || path.join(process.cwd(), "mobile/android/app/build.gradle");

const signingPropertiesBlock = `def swicoUploadSigningProperties = new Properties()
def swicoUploadSigningPropertiesFile = rootProject.file("key.properties")
if (swicoUploadSigningPropertiesFile.exists()) {
    swicoUploadSigningPropertiesFile.withInputStream { swicoUploadSigningProperties.load(it) }
}
def swicoUploadStoreFile = swicoUploadSigningProperties.getProperty("storeFile")
def swicoUploadStorePassword = swicoUploadSigningProperties.getProperty("storePassword")
def swicoUploadKeyAlias = swicoUploadSigningProperties.getProperty("keyAlias")
def swicoUploadKeyPassword = swicoUploadSigningProperties.getProperty("keyPassword")
def swicoUploadSigningComplete = [
    swicoUploadStoreFile,
    swicoUploadStorePassword,
    swicoUploadKeyAlias,
    swicoUploadKeyPassword,
].every { it != null && it.toString().trim() }

gradle.taskGraph.whenReady { taskGraph ->
    def swicoReleaseSigningTasks = ["assembleRelease", "bundleRelease", "packageRelease"]
    if (taskGraph.allTasks.any { swicoReleaseSigningTasks.contains(it.name) } && !swicoUploadSigningComplete) {
        throw new GradleException("Swico release signing requires mobile/android/key.properties. Run ./scripts/build-android_release-apk.sh with SWICO_UPLOAD_* env vars or release-signing.properties.")
    }
}

`;

const releaseSigningConfigBlock = `        release {
            storeFile swicoUploadStoreFile ? file(swicoUploadStoreFile) : file("__missing_swico_upload_store_file__")
            storePassword swicoUploadStorePassword ?: ""
            keyAlias swicoUploadKeyAlias ?: ""
            keyPassword swicoUploadKeyPassword ?: ""
        }
`;

function findMatchingBrace(source, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findBlock(source, blockName, startIndex = 0, endIndex = source.length) {
  const pattern = new RegExp(`\\b${blockName}\\s*\\{`, "g");
  pattern.lastIndex = startIndex;
  const match = pattern.exec(source);
  if (!match || match.index >= endIndex) return null;
  const openBrace = source.indexOf("{", match.index);
  const closeBrace = findMatchingBrace(source, openBrace);
  if (closeBrace < 0 || closeBrace >= endIndex) return null;
  return {
    start: match.index,
    openBrace,
    closeBrace,
    end: closeBrace + 1,
    text: source.slice(match.index, closeBrace + 1),
  };
}

function insertBeforeAndroidBlock(source) {
  if (source.includes("swicoUploadSigningPropertiesFile")) return source;

  const androidBlock = findBlock(source, "android");
  if (!androidBlock) {
    throw new Error("Could not find android block in generated app/build.gradle.");
  }

  return `${source.slice(0, androidBlock.start)}${signingPropertiesBlock}${source.slice(androidBlock.start)}`;
}

function upsertSigningConfig(source) {
  const androidBlock = findBlock(source, "android");
  if (!androidBlock) {
    throw new Error("Could not find android block in generated app/build.gradle.");
  }

  let signingConfigs = findBlock(source, "signingConfigs", androidBlock.openBrace, androidBlock.closeBrace);

  if (!signingConfigs) {
    const buildTypes = findBlock(source, "buildTypes", androidBlock.openBrace, androidBlock.closeBrace);
    if (!buildTypes) {
      throw new Error("Could not find android.signingConfigs or android.buildTypes in generated app/build.gradle.");
    }
    const block = `    signingConfigs {\n${releaseSigningConfigBlock}    }\n`;
    return `${source.slice(0, buildTypes.start)}${block}${source.slice(buildTypes.start)}`;
  }

  let nextSource = source;
  const releaseConfig = findBlock(
    nextSource,
    "release",
    signingConfigs.openBrace,
    signingConfigs.closeBrace,
  );

  if (releaseConfig) {
    nextSource = `${nextSource.slice(0, releaseConfig.start)}${nextSource.slice(releaseConfig.end)}`;
    signingConfigs = findBlock(nextSource, "signingConfigs", androidBlock.openBrace, androidBlock.closeBrace);
    if (!signingConfigs) {
      throw new Error("Could not re-read android.signingConfigs after removing existing release signing block.");
    }
  }

  return `${nextSource.slice(0, signingConfigs.closeBrace)}${releaseSigningConfigBlock}\n${nextSource.slice(signingConfigs.closeBrace)}`;
}

function pointReleaseBuildTypeAtUploadKey(source) {
  const androidBlock = findBlock(source, "android");
  const buildTypes = androidBlock
    ? findBlock(source, "buildTypes", androidBlock.openBrace, androidBlock.closeBrace)
    : null;
  const releaseBuildType = buildTypes
    ? findBlock(source, "release", buildTypes.openBrace, buildTypes.closeBrace)
    : null;

  if (!releaseBuildType) {
    throw new Error("Could not find android.buildTypes.release in generated app/build.gradle.");
  }

  let releaseText = releaseBuildType.text;
  if (/signingConfig\s+signingConfigs\.debug/.test(releaseText)) {
    releaseText = releaseText.replace(/signingConfig\s+signingConfigs\.debug/g, "signingConfig signingConfigs.release");
  } else if (!/signingConfig\s+signingConfigs\.release/.test(releaseText)) {
    releaseText = releaseText.replace(/\{\n/, "{\n            signingConfig signingConfigs.release\n");
  }

  return `${source.slice(0, releaseBuildType.start)}${releaseText}${source.slice(releaseBuildType.end)}`;
}

function assertNoDebugReleaseSigning(source) {
  const androidBlock = findBlock(source, "android");
  const buildTypes = androidBlock
    ? findBlock(source, "buildTypes", androidBlock.openBrace, androidBlock.closeBrace)
    : null;
  const releaseBuildType = buildTypes
    ? findBlock(source, "release", buildTypes.openBrace, buildTypes.closeBrace)
    : null;

  if (!releaseBuildType) {
    throw new Error("Could not verify android.buildTypes.release.");
  }

  if (/signingConfig\s+signingConfigs\.debug/.test(releaseBuildType.text)) {
    throw new Error("Release buildType still points at signingConfigs.debug.");
  }
  if (!/signingConfig\s+signingConfigs\.release/.test(releaseBuildType.text)) {
    throw new Error("Release buildType does not point at signingConfigs.release.");
  }
}

if (!fs.existsSync(gradleFile)) {
  console.error(`Generated Android app build.gradle not found: ${gradleFile}`);
  process.exit(1);
}

let source = fs.readFileSync(gradleFile, "utf8");
source = insertBeforeAndroidBlock(source);
source = upsertSigningConfig(source);
source = pointReleaseBuildTypeAtUploadKey(source);
assertNoDebugReleaseSigning(source);

fs.writeFileSync(gradleFile, source);
