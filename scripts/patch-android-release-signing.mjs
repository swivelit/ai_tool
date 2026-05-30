#!/usr/bin/env node
import fs from "node:fs";

const gradlePath = process.argv[2];

if (!gradlePath) {
  console.error("Usage: patch-android-release-signing.mjs <mobile/android/app/build.gradle>");
  process.exit(2);
}

let source = fs.readFileSync(gradlePath, "utf8");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function findBlockStart(text, name, from = 0) {
  const pattern = new RegExp(`(^|\\n)([ \\t]*)${name}\\s*\\{`, "g");
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  if (!match) return null;
  const open = pattern.lastIndex - 1;
  return { start: match.index + match[1].length, open };
}

function findBlock(text, name, from = 0) {
  const found = findBlockStart(text, name, from);
  if (!found) return null;

  let depth = 0;
  for (let index = found.open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { ...found, close: index };
      }
    }
  }

  return null;
}

function findNestedBlock(text, name, parent) {
  const found = findBlock(text, name, parent.open + 1);
  if (!found || found.close > parent.close) return null;
  return found;
}

function replaceRange(text, start, end, replacement) {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

const signingHeader = `def swicoUploadSigningProperties = new Properties()
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

if (!source.includes("def swicoUploadSigningProperties = new Properties()")) {
  const androidBlock = findBlock(source, "android");
  if (!androidBlock) fail("Could not find android block in generated Gradle file.");
  source = replaceRange(source, androidBlock.start, androidBlock.start, `${signingHeader}\n`);
}

let androidBlock = findBlock(source, "android");
if (!androidBlock) fail("Could not find android block after signing header insertion.");

let signingConfigsBlock = findNestedBlock(source, "signingConfigs", androidBlock);
if (!signingConfigsBlock) fail("Could not find signingConfigs block in generated Gradle file.");

const signingConfigsBody = source.slice(signingConfigsBlock.open, signingConfigsBlock.close);
if (!/\n\s*release\s*\{/.test(signingConfigsBody)) {
  const debugSigningBlock = findNestedBlock(source, "debug", signingConfigsBlock);
  if (!debugSigningBlock) fail("Could not find debug signingConfig block.");

  const releaseSigningConfig = `
        release {
            storeFile swicoUploadStoreFile ? file(swicoUploadStoreFile) : file("__missing_swico_upload_store_file__")
            storePassword swicoUploadStorePassword ?: ""
            keyAlias swicoUploadKeyAlias ?: ""
            keyPassword swicoUploadKeyPassword ?: ""
        }
`;
  source = replaceRange(source, debugSigningBlock.close + 1, debugSigningBlock.close + 1, releaseSigningConfig);
}

androidBlock = findBlock(source, "android");
if (!androidBlock) fail("Could not find android block after release signingConfig insertion.");

const buildTypesBlock = findNestedBlock(source, "buildTypes", androidBlock);
if (!buildTypesBlock) fail("Could not find buildTypes block in generated Gradle file.");

const releaseBuildTypeBlock = findNestedBlock(source, "release", buildTypesBlock);
if (!releaseBuildTypeBlock) fail("Could not find release buildType block.");

let releaseBuildTypeBody = source.slice(
  releaseBuildTypeBlock.open + 1,
  releaseBuildTypeBlock.close,
);
releaseBuildTypeBody = releaseBuildTypeBody.replace(
  /^\s*signingConfig\s+signingConfigs\.debug\s*$/gm,
  "            signingConfig signingConfigs.release",
);

if (!/signingConfig\s+signingConfigs\.release/.test(releaseBuildTypeBody)) {
  releaseBuildTypeBody = `\n            signingConfig signingConfigs.release${releaseBuildTypeBody}`;
}

source = replaceRange(
  source,
  releaseBuildTypeBlock.open + 1,
  releaseBuildTypeBlock.close,
  releaseBuildTypeBody,
);

androidBlock = findBlock(source, "android");
signingConfigsBlock = findNestedBlock(source, "signingConfigs", androidBlock);
const releaseSigningBlock = findNestedBlock(source, "release", signingConfigsBlock);
const buildTypesAfter = findNestedBlock(source, "buildTypes", androidBlock);
const releaseBuildTypeAfter = findNestedBlock(source, "release", buildTypesAfter);
const releaseBuildTypeAfterBody = source.slice(
  releaseBuildTypeAfter.open + 1,
  releaseBuildTypeAfter.close,
);

if (!releaseSigningBlock) fail("Release signingConfig was not inserted.");
if (!/storeFile\s+swicoUploadStoreFile/.test(source.slice(releaseSigningBlock.open, releaseSigningBlock.close))) {
  fail("Release signingConfig does not read Swico upload key properties.");
}
if (!/signingConfig\s+signingConfigs\.release/.test(releaseBuildTypeAfterBody)) {
  fail("Release buildType does not point at signingConfigs.release.");
}
if (/signingConfig\s+signingConfigs\.debug/.test(releaseBuildTypeAfterBody)) {
  fail("Release buildType still points at signingConfigs.debug.");
}

fs.writeFileSync(gradlePath, source);
