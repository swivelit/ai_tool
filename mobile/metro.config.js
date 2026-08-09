const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Legal copy is shared from the authoritative website source. Metro normally
// restricts resolution to the mobile project root, so explicitly watch the
// repository's web source tree without changing the website or bundling it as
// a second application.
config.watchFolders = [path.resolve(__dirname, "../web")];

const legalContentPath = path.resolve(__dirname, "../web/src/content/legalContent.json");
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "../../../web/src/content/legalContent.json") {
    return { type: "sourceFile", filePath: legalContentPath };
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

config.resolver.assetExts = Array.from(
  new Set([...(config.resolver.assetExts || []), "csv", "jsonl", "gguf", "onnx", "ort", "tflite"])
);

module.exports = config;
